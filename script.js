document.addEventListener('DOMContentLoaded', () => {
    const unlockButton = document.getElementById('unlockButton');
    const startButton = document.getElementById('startButton');
    const statusDiv = document.getElementById('status');
    const outputDiv = document.getElementById('output');

    let audioContext;
    let mediaRecorder;
    let audioChunks = [];
    let currentAudioPlayer = new Audio(); // Unico player audio riutilizzabile
    let currentAudioUrl = null; // Per tenere traccia dell'URL dell'oggetto audio da revocare

    // Dati audio silenzioso in base64 (un brevissimo file WAV)
    const silentAudioBase64 = "data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

    // Inizializza AudioContext (necessario per sbloccare l'audio sui browser moderni)
    function initAudioContext() {
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log("AudioContext creato.");
            } catch (e) {
                console.error("AudioContext non supportato.", e);
                statusDiv.textContent = "Il tuo browser non supporta AudioContext, l'audio potrebbe non funzionare.";
                return false;
            }
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log("AudioContext ripreso con successo.");
            }).catch(e => {
                console.error("Errore nel riprendere AudioContext:", e);
            });
        }
        return true;
    }

    unlockButton.onclick = async () => {
        statusDiv.textContent = "Tentativo di abilitare l'audio...";
        console.log("Unlock Audio button cliccato.");

        if (!initAudioContext()) {
            statusDiv.textContent = "Impossibile inizializzare il contesto audio.";
            return;
        }

        // Tentativo di riprodurre un suono silenzioso per "sbloccare" la riproduzione audio
        // Questo DEVE avvenire direttamente in risposta a un gesto dell'utente
        currentAudioPlayer.src = silentAudioBase64;
        currentAudioPlayer.load(); // Assicurati che l'audio sia caricato prima di play()

        try {
            await currentAudioPlayer.play();
            console.log("Audio silenzioso riprodotto con successo. L'audio dovrebbe essere abilitato.");
            statusDiv.textContent = "Audio abilitato! Clicca 'Parla' per iniziare.";
            unlockButton.disabled = true;
            unlockButton.style.display = 'none'; // Nascondi il pulsante dopo successo
            startButton.disabled = false;
        } catch (error) {
            console.error("Errore durante la riproduzione dell'audio silenzioso:", error);
            let userMessage = "L'audio non può essere abilitato. ";
            if (error.name === 'NotAllowedError') {
                userMessage += "Il browser ha bloccato la riproduzione automatica. Assicurati di aver dato i permessi per la riproduzione automatica dell'audio per questo sito nelle impostazioni del tuo browser e ricarica la pagina.";
            } else if (error.name === 'AbortError') {
                 userMessage += "La riproduzione è stata interrotta. Questo può succedere se cerchi di riprodurre un nuovo audio prima che il precedente sia caricato. Riprova.";
            } else {
                userMessage += `Dettagli errore: ${error.message}. Prova a ricaricare la pagina o controlla i permessi del browser.`;
            }
            statusDiv.textContent = userMessage;
            // Non disabilitare il pulsante unlock se fallisce, così l'utente può riprovare dopo aver sistemato i permessi
        }
    };

    startButton.onclick = async () => {
        if (currentAudioPlayer && !currentAudioPlayer.paused) {
            currentAudioPlayer.pause();
            currentAudioPlayer.currentTime = 0;
            console.log("Riproduzione audio precedente interrotta.");
        }
        if (currentAudioUrl) {
            URL.revokeObjectURL(currentAudioUrl); // Revoca l'URL dell'oggetto precedente
            currentAudioUrl = null;
            console.log("URL oggetto audio precedente revocato.");
        }

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            statusDiv.textContent = "In ascolto...";
            startButton.disabled = true;
            startButton.classList.add('listening'); // Aggiungi classe per feedback visivo

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];

                mediaRecorder.ondataavailable = event => {
                    audioChunks.push(event.data);
                };

                mediaRecorder.onstop = async () => {
                    statusDiv.textContent = "Trascrizione in corso...";
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    // const audioUrl = URL.createObjectURL(audioBlob); // Per debug se necessario
                    // console.log("Audio registrato:", audioUrl);

                    // Invia audio al backend per trascrizione (simulato qui, implementerai dopo)
                    // Per ora, simuliamo una trascrizione e invio a /api/chat
                    // const userText = "Ciao mondo, come stai?"; // Trascrizione fittizia
                    // console.log("Testo trascritto (fittizio):", userText);
                    // await sendToChatAPI(userText);

                    // Invece di simulare, implementiamo l'invio del blob al server per la trascrizione.
                    // Questo richiederà un endpoint API per la trascrizione.
                    // Per ora, continuiamo ad usare SpeechRecognition API del browser se disponibile,
                    // altrimenti questa parte andrà modificata.

                    // *** LA LOGICA DI SPEECHRECOGNITION È SPOSTATA QUI SOTTO ***
                };
                
                // Utilizziamo SpeechRecognition API del browser se disponibile
                if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
                    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                    const recognition = new Recognition();
                    recognition.lang = 'it-IT';
                    recognition.interimResults = false;
                    recognition.maxAlternatives = 1;

                    recognition.onstart = () => {
                        statusDiv.textContent = "Sto ascoltando... Parla ora!";
                        startButton.classList.add('listening');
                    };

                    recognition.onresult = async (event) => {
                        const userText = event.results[0][0].transcript;
                        addMessageToChat("Tu", userText);
                        statusDiv.textContent = "Invio a OpenAI...";
                        await sendToChatAPI(userText);
                    };

                    recognition.onspeechend = () => {
                        recognition.stop();
                        statusDiv.textContent = "Trascrizione completata.";
                        startButton.classList.remove('listening');
                        startButton.disabled = false;
                    };

                    recognition.onerror = (event) => {
                        console.error("Errore SpeechRecognition:", event.error);
                        statusDiv.textContent = `Errore durante il riconoscimento: ${event.error}. Riprova.`;
                        startButton.classList.remove('listening');
                        startButton.disabled = false;
                    };
                    
                    recognition.start();

                } else {
                    // Fallback se SpeechRecognition non è supportato (qui dovresti gestire la registrazione e invio del blob)
                    statusDiv.textContent = "SpeechRecognition non supportato. La registrazione manuale non è ancora implementata.";
                    startButton.disabled = false;
                    startButton.classList.remove('listening');
                }

            } catch (err) {
                console.error("Errore durante l'accesso al microfono:", err);
                statusDiv.textContent = "Errore accesso al microfono: " + err.message;
                startButton.disabled = false;
                startButton.classList.remove('listening');
            }
        } else {
            statusDiv.textContent = "getUserMedia non supportato dal tuo browser.";
            startButton.disabled = true;
        }
    };

    async function sendToChatAPI(userMessage) {
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userMessage: userMessage })
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `Errore HTTP: ${response.status}`);
            }
            const data = await response.json();
            addMessageToChat("AI", data.reply);
            statusDiv.textContent = "Sintesi vocale in corso...";
            await speak(data.reply);
        } catch (error) {
            console.error("Errore chiamata /api/chat:", error);
            statusDiv.textContent = `Errore chat: ${error.message}`;
            addMessageToChat("Sistema", `Errore nella comunicazione con l'AI: ${error.message}`);
            startButton.disabled = false;
            startButton.classList.remove('listening');
        }
    }

    async function speak(textToSpeak) {
        if (!textToSpeak.trim()) {
            console.log("Nessun testo da sintetizzare.");
            statusDiv.textContent = "Pronto."; // O messaggio più appropriato
            startButton.disabled = false;
            startButton.classList.remove('listening');
            return;
        }

        statusDiv.textContent = "Richiesta sintesi vocale...";
        try {
            const response = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textToSpeak })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Errore HTTP ${response.status}: ${errorText}`);
            }

            const audioBlob = await response.blob();
            if (currentAudioUrl) {
                URL.revokeObjectURL(currentAudioUrl); // Revoca l'URL dell'oggetto precedente prima di crearne uno nuovo
            }
            currentAudioUrl = URL.createObjectURL(audioBlob);
            
            currentAudioPlayer.src = currentAudioUrl;
            currentAudioPlayer.load(); // È buona norma chiamare load() quando si cambia src

            statusDiv.textContent = "Riproduzione risposta...";

            // Gestione eventi per il player audio
            currentAudioPlayer.onended = () => {
                console.log("Riproduzione audio AI completata.");
                statusDiv.textContent = "Pronto per una nuova domanda.";
                startButton.disabled = false;
                startButton.classList.remove('listening');
                if (currentAudioUrl) { // Revoca l'URL dopo la riproduzione
                    URL.revokeObjectURL(currentAudioUrl);
                    currentAudioUrl = null;
                }
            };
            currentAudioPlayer.onerror = (e) => {
                console.error("Errore durante la riproduzione dell'audio AI:", e, currentAudioPlayer.error);
                statusDiv.textContent = "Errore durante la riproduzione dell'audio. Controlla la console.";
                startButton.disabled = false;
                startButton.classList.remove('listening');
                 if (currentAudioUrl) { // Revoca l'URL anche in caso di errore
                    URL.revokeObjectURL(currentAudioUrl);
                    currentAudioUrl = null;
                }
            };

            await currentAudioPlayer.play();
            console.log("Riproduzione audio AI avviata.");

        } catch (error) {
            console.error("Errore chiamata /api/tts o riproduzione:", error);
            statusDiv.textContent = `Errore TTS: ${error.message}`;
            addMessageToChat("Sistema", `Errore nella sintesi vocale: ${error.message}`);
            startButton.disabled = false;
            startButton.classList.remove('listening');
        }
    }

    function addMessageToChat(sender, message) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender.toLowerCase() + '-message');
        
        const senderElement = document.createElement('strong');
        senderElement.textContent = sender + ": ";
        
        const contentElement = document.createElement('span');
        contentElement.textContent = message;
        
        messageElement.appendChild(senderElement);
        messageElement.appendChild(contentElement);
        
        outputDiv.appendChild(messageElement);
        outputDiv.scrollTop = outputDiv.scrollHeight; // Scrolla alla fine
    }

    // Inizializzazione stato pulsanti
    startButton.disabled = true;
    statusDiv.textContent = "Clicca 'Abilita Audio' per iniziare.";
});
