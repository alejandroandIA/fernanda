const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;
let currentAudio = new Audio(); // Crea l'oggetto Audio una volta all'inizio
let audioUrlToRevoke = null; // Per tenere traccia dell'URL da revocare

// Verifica se il browser supporta SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    startButton.onclick = () => {
        if (currentAudio && !currentAudio.paused) { // Se l'audio è in riproduzione
            currentAudio.pause();
            currentAudio.currentTime = 0;
            if (audioUrlToRevoke) {
                URL.revokeObjectURL(audioUrlToRevoke); // Revoca se interrompiamo
                audioUrlToRevoke = null;
            }
        }
        // Prova a caricare un silenzio "fittizio" per "sbloccare" l'audio su Safari
        // Questo è un trucco che a volte funziona per abilitare l'autoplay.
        // Lo facciamo qui perché è legato all'interazione utente diretta.
        if (currentAudio.src === "") { // Solo la prima volta o se resettato
             // currentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA"; // Silenzio brevissimo
             // currentAudio.load(); // Carica il silenzio
        }

        try {
            statusDiv.textContent = 'In ascolto... parla pure!';
            recognition.start();
            startButton.disabled = true;
            startButton.textContent = "Sto ascoltando...";
        } catch (error) {
            console.error("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Errore: non posso iniziare l\'ascolto ora. Riprova.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onresult = async (event) => {
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI...';
        startButton.disabled = true;
        startButton.textContent = "Elaboro...";

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userMessage: speechResult }),
            });

            if (!response.ok) {
                let errorDetails = 'Errore API chat'; /* ... gestione errore ... */ throw new Error(`Errore API Chat: ${errorDetails}`);
            }
            const data = await response.json();
            const aiResponse = data.reply;

            if (aiResponse) {
                addMessageToChat('AI: ' + aiResponse, 'assistant');
                speak(aiResponse);
            } else {
                /* ... gestione no aiResponse ... */
                startButton.disabled = false; startButton.textContent = "🎤 Parla";
            }
        } catch (error) {
            /* ... gestione errore chat ... */
            console.error('Errore API chat:', error);
            addMessageToChat('AI: Errore (chat): ' + error.message, 'assistant');
            statusDiv.textContent = 'Errore. Riprova.';
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        }
    };
    // ... resto di recognition.onspeechend, onnomatch, onerror come prima ...
    recognition.onspeechend = () => { recognition.stop(); };
    recognition.onnomatch = () => { statusDiv.textContent = "Non ho capito."; startButton.disabled = false; startButton.textContent = "🎤 Parla"; };
    recognition.onerror = (event) => { statusDiv.textContent = 'Errore riconoscimento: ' + event.error; startButton.disabled = false; startButton.textContent = "🎤 Parla"; };


} else { /* ... browser non supporta SpeechRecognition ... */ }

function addMessageToChat(message, sender) { /* ... come prima ... */
    const messageElement = document.createElement('div'); messageElement.classList.add('message', sender); messageElement.textContent = message; outputDiv.appendChild(messageElement); outputDiv.scrollTop = outputDiv.scrollHeight;
}

async function speak(textToSpeak) {
    if (!textToSpeak) { /* ... gestione no testo ... */ startButton.disabled = false; startButton.textContent = "🎤 Parla"; return; }
    statusDiv.textContent = "L'AI sta parlando...";
    startButton.disabled = true; startButton.textContent = "Attendere...";

    if (audioUrlToRevoke) { // Revoca l'URL precedente se esiste
        URL.revokeObjectURL(audioUrlToRevoke);
        audioUrlToRevoke = null;
    }

    try {
        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textToSpeak }),
        });

        if (!response.ok) {
            let errorDetails = 'Errore generazione audio'; /* ... gestione errore ... */ throw new Error(`Errore API TTS: ${errorDetails}`);
        }
        const audioBlob = await response.blob();
        audioUrlToRevoke = URL.createObjectURL(audioBlob); // Salva il nuovo URL per revocarlo dopo
        currentAudio.src = audioUrlToRevoke; // Imposta la sorgente sull'oggetto Audio esistente
        currentAudio.load(); // Importante: chiama load() dopo aver impostato src

        // Rimuovi vecchi listener per evitare duplicazioni
        currentAudio.oncanplaythrough = null;
        currentAudio.onended = null;
        currentAudio.onerror = null;

        currentAudio.oncanplaythrough = () => {
            currentAudio.play().catch(e => {
                console.error("Errore play() in oncanplaythrough:", e);
                statusDiv.textContent = 'Errore riproduzione (play).';
                addMessageToChat('AI (audio play error): ' + e.message, 'assistant');
                if (audioUrlToRevoke) { URL.revokeObjectURL(audioUrlToRevoke); audioUrlToRevoke = null; }
                startButton.disabled = false; startButton.textContent = "🎤 Parla";
            });
        };
        
        currentAudio.onended = () => {
            statusDiv.textContent = 'Premi "Parla" per continuare.';
            if (audioUrlToRevoke) { URL.revokeObjectURL(audioUrlToRevoke); audioUrlToRevoke = null; }
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
        };

        currentAudio.onerror = (e) => {
            console.error('Errore elemento Audio:', e);
            statusDiv.textContent = 'Errore caricamento/riproduzione audio.';
            if (audioUrlToRevoke) { URL.revokeObjectURL(audioUrlToRevoke); audioUrlToRevoke = null; }
            startButton.disabled = false; startButton.textContent = "🎤 Parla";
            addMessageToChat('AI (audio load/play error): Errore audio.', 'assistant');
        };

    } catch (error) {
        /* ... gestione errore TTS ... */
        console.error('Errore API TTS:', error);
        addMessageToChat('AI: Errore (TTS): ' + error.message, 'assistant');
        statusDiv.textContent = 'Errore generazione audio.';
        startButton.disabled = false; startButton.textContent = "🎤 Parla";
        if (audioUrlToRevoke) { URL.revokeObjectURL(audioUrlToRevoke); audioUrlToRevoke = null; }
    }
}
