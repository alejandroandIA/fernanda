document.addEventListener('DOMContentLoaded', () => {
    const unlockButton = document.getElementById('unlockButton');
    const startButton = document.getElementById('startButton');
    const statusDiv = document.getElementById('status');
    const outputDiv = document.getElementById('output');

    let audioContext;
    let currentAudioPlayer = new Audio(); // Unico player audio riutilizzabile
    let currentAudioUrl = null;
    let unlockInProgress = false; // Flag per prevenire click multipli sullo sblocco audio

    // Dati audio silenzioso in base64 (un brevissimo file WAV)
    const silentAudioBase64 = "data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

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

    unlockButton.onclick = () => {
        if (unlockInProgress) {
            console.log("Sblocco audio già in corso.");
            return;
        }
        unlockInProgress = true;
        statusDiv.textContent = "Tentativo di abilitare l'audio...";
        console.log("Unlock Audio button cliccato.");

        if (!initAudioContext()) {
            statusDiv.textContent = "Impossibile inizializzare il contesto audio.";
            unlockInProgress = false;
            return;
        }

        const onCanPlayThrough = async () => {
            console.log("Audio silenzioso pronto per essere riprodotto (canplaythrough).");
            try {
                await currentAudioPlayer.play();
                console.log("Audio silenzioso riprodotto con successo. L'audio dovrebbe essere abilitato.");
                statusDiv.textContent = "Audio abilitato! Clicca 'Parla' per iniziare.";
                unlockButton.disabled = true;
                unlockButton.style.display = 'none';
                startButton.disabled = false;
                unlockInProgress = false; 
            } catch (error) {
                console.error("Errore durante la riproduzione dell'audio silenzioso (dopo canplaythrough):", error);
                let userMessage = "L'audio non può essere abilitato (fase play). ";
                if (error.name === 'NotAllowedError') {
                    userMessage += "Il browser ha bloccato la riproduzione. Assicurati dei permessi per l'autoplay e ricarica.";
                } else {
                    userMessage += `Dettagli errore: ${error.message}. Riprova o ricarica la pagina.`;
                }
                statusDiv.textContent = userMessage;
                unlockInProgress = false;
            }
        };

        const onAudioLoadError = (e) => {
            console.error("Errore caricamento audio silenzioso:", e, currentAudioPlayer.error);
            statusDiv.textContent = "Errore nel caricare il suono test per abilitare l'audio. Riprova.";
            unlockInProgress = false;
        };
        
        // Aggiungi i listener con {once: true} così si auto-rimuovono dopo essere stati chiamati una volta
        currentAudioPlayer.addEventListener('canplaythrough', onCanPlayThrough, { once: true });
        currentAudioPlayer.addEventListener('error', onAudioLoadError, { once: true });

        console.log("Impostazione src e load per audio silenzioso...");
        currentAudioPlayer.src = silentAudioBase64;
        currentAudioPlayer.load(); // Questo avvia il caricamento e dovrebbe triggerare 'canplaythrough' o 'error'
    };

    startButton.onclick = async () => {
        if (currentAudioPlayer && !currentAudioPlayer.paused) {
            currentAudioPlayer.pause();
            currentAudioPlayer.currentTime = 0;
            console.log("Riproduzione audio precedente interrotta.");
        }
        if (currentAudioUrl) {
            URL.revokeObjectURL(currentAudioUrl);
            currentAudioUrl = null;
            console.log("URL oggetto audio precedente revocato.");
        }

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            statusDiv.textContent = "In ascolto...";
            startButton.disabled = true;
            startButton.classList.add('listening');

            try {
                // Usiamo SpeechRecognition API del browser
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
                        // Non riabilitare startButton qui, lo fa speak() o il suo errore
                    };

                    recognition.onerror = (event) => {
                        console.error("Errore SpeechRecognition:", event.error);
                        statusDiv.textContent = `Errore durante il riconoscimento: ${event.error}. Riprova.`;
                        startButton.classList.remove('listening');
                        startButton.disabled = false;
                    };
                    
                    // Necessario richiedere i permessi del microfono prima di avviare il recognition
                    // anche se SpeechRecognition lo fa implicitamente, è buona norma gestirlo.
                    await navigator.mediaDevices.getUserMedia({ audio: true }); // Richiesta permesso
                    recognition.start();

                } else {
                    statusDiv.textContent = "SpeechRecognition non supportato dal tuo browser.";
                    startButton.disabled = false;
                    startButton.classList.remove('listening');
                }

            } catch (err) {
                console.error("Errore durante l'accesso al microfono o SpeechRec:", err);
                statusDiv.textContent = "Errore accesso al microfono: " + err.message;
                if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                    statusDiv.textContent = "Permesso microfono negato. Abilitalo nelle impostazioni del browser.";
                }
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
            statusDiv.textContent = "Pronto.";
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
                const errorText = await response.text(); // Leggi come testo per errori più dettagliati da OpenAI
                console.error("Errore API TTS:", errorText);
                throw new Error(`Errore HTTP ${response.status} da API TTS. Dettagli: ${errorText.substring(0,100)}`);
            }

            const audioBlob = await response.blob();
            if (currentAudioUrl) {
                URL.revokeObjectURL(currentAudioUrl);
            }
            currentAudioUrl = URL.createObjectURL(audioBlob);
            
            currentAudioPlayer.src = currentAudioUrl;
            
            const playPromise = currentAudioPlayer.play();

            if (playPromise !== undefined) {
                playPromise.then(() => {
                    console.log("Riproduzione audio AI avviata.");
                    statusDiv.textContent = "Sto parlando..."; // Cambiato per chiarezza
                }).catch(error => {
                    console.error("Errore durante la riproduzione dell'audio AI:", error);
                    statusDiv.textContent = "Errore riproduzione audio AI. Controlla console.";
                    startButton.disabled = false;
                    startButton.classList.remove('listening');
                    if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
                });
            }

            currentAudioPlayer.onended = () => {
                console.log("Riproduzione audio AI completata.");
                statusDiv.textContent = "Pronto per una nuova domanda.";
                startButton.disabled = false;
                startButton.classList.remove('listening');
                if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
            };
            // Gestione errore già in playPromise.catch, ma un listener generico sull'elemento non fa male
            currentAudioPlayer.onerror = (e) => {
                console.error("Errore sull'elemento AudioPlayer durante la riproduzione AI:", e, currentAudioPlayer.error);
                // Non sovrascrivere il messaggio di status se playPromise.catch lo ha già gestito.
                // Potrebbe essere ridondante.
                if (statusDiv.textContent.startsWith("Sto parlando...")) { // Solo se l'errore non è già stato catturato
                     statusDiv.textContent = "Errore durante la riproduzione audio AI.";
                }
                startButton.disabled = false;
                startButton.classList.remove('listening');
                if (currentAudioUrl) { URL.revokeObjectURL(currentAudioUrl); currentAudioUrl = null; }
            };

        } catch (error) {
            console.error("Errore chiamata /api/tts o creazione blob:", error);
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
        outputDiv.scrollTop = outputDiv.scrollHeight;
    }

    startButton.disabled = true;
    statusDiv.textContent = "Clicca 'Abilita Audio' per iniziare.";
});
