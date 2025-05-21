// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

// MediaRecorder per catturare audio per Whisper
let mediaRecorder;
let audioChunks = [];
let silenceTimeout;
const SILENCE_THRESHOLD_MS = 2000; // 2 secondi di silenzio per terminare la registrazione

let currentAudio = null; // Per l'audio di risposta di Fernanda
let isFernandaSpeaking = false;
let currentConversationState = 'idle'; // Stati: idle, listeningToUser, processingTranscription, processingChat, fernandaSpeaking

// Helper per aggiornare il pulsante e lo stato
function updateUI(state, buttonText, buttonIcon, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIcon}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    // Disabilita durante le fasi di elaborazione API
    controlButton.disabled = (state === 'processingTranscription' || state === 'processingChat');
    console.log("UI Update:", state, buttonText, statusText);
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Controlla i formati supportati (webm con opus è ampiamente supportato e buono per Whisper)
        const options = { mimeType: 'audio/webm;codecs=opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn(`${options.mimeType} not supported, trying default.`);
            delete options.mimeType; // Prova con il default del browser
        }
        
        mediaRecorder = new MediaRecorder(stream, options);
        audioChunks = []; // Resetta i chunk per la nuova registrazione

        mediaRecorder.ondataavailable = event => {
            audioChunks.push(event.data);
            console.log("Audio chunk received, size:", event.data.size);
             // Resetta il timer di silenzio ogni volta che ricevi dati audio
            clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
                if (mediaRecorder && mediaRecorder.state === "recording") {
                    console.log("Silence detected, stopping recording.");
                    mediaRecorder.stop();
                }
            }, SILENCE_THRESHOLD_MS);
        };

        mediaRecorder.onstart = () => {
            updateUI('listeningToUser', 'Parla Ora...', 'icon-listening', 'Ti ascolto...');
            clearTimeout(silenceTimeout); // Inizia il timer di silenzio
             silenceTimeout = setTimeout(() => {
                if (mediaRecorder && mediaRecorder.state === "recording") {
                    console.log("Initial silence timeout, stopping recording.");
                    mediaRecorder.stop(); // Ferma se non c'è parlato all'inizio
                }
            }, SILENCE_THRESHOLD_MS + 1000); // Un po' più di tempo all'inizio
        };

        mediaRecorder.onstop = async () => {
            // Ferma le tracce dello stream per rilasciare il microfono
            stream.getTracks().forEach(track => track.stop());
            
            console.log("Recording stopped. Total chunks:", audioChunks.length);
            if (audioChunks.length === 0) {
                console.log("No audio data recorded.");
                updateUI('idle', 'Riprova', 'icon-mic', 'Nessun audio registrato. Riprova.');
                return;
            }

            updateUI('processingTranscription', 'Trascrivo...', 'icon-thinking', 'Invio audio per trascrizione...');
            const audioBlob = new Blob(audioChunks, { type: audioChunks[0].type || 'audio/webm' }); // Usa il tipo del primo chunk o un default
            
            // Invia audioBlob a /api/transcribe
            const formData = new FormData();
            formData.append('audio', audioBlob, 'user_audio.webm'); // Il nome file è opzionale ma utile

            try {
                const transcribeResponse = await fetch('/api/transcribe', {
                    method: 'POST',
                    body: formData // FormData imposta automaticamente Content-Type a multipart/form-data
                });

                if (!transcribeResponse.ok) {
                    const errData = await transcribeResponse.json().catch(() => ({error: "Errore API Trascrizione sconosciuto"}));
                    throw new Error(errData.transcript || errData.error || `Errore Trascrizione: ${transcribeResponse.status}`);
                }
                const { transcript } = await transcribeResponse.json();
                console.log("Whisper transcript:", transcript);

                if (!transcript || transcript.trim().length < 2) { // Controllo per trascrizioni vuote o troppo corte
                    updateUI('idle', 'Riprova', 'icon-mic', 'Non ho capito bene. Puoi ripetere?');
                    return;
                }
                
                // Ora procedi con la chat usando la trascrizione da Whisper
                processChat(transcript);

            } catch (error) {
                console.error('Errore trascrizione (frontend):', error);
                updateUI('idle', 'Errore Trasc.', 'icon-mic', `Oops: ${error.message}. Riprova.`);
            }
        };
        
        mediaRecorder.start(500); // Raccogli dati ogni 500ms per il timer di silenzio
        console.log("MediaRecorder started, state:", mediaRecorder.state);

    } catch (err) {
        console.error('Errore ottenimento media o avvio MediaRecorder:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Permesso microfono negato.';
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') msg = 'Nessun microfono trovato.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
    }
}

async function processChat(transcript) {
    updateUI('processingChat', 'Penso...', 'icon-thinking', 'Ottima domanda, ci penso...');
    try {
        const chatResponse = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: transcript })
        });

        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({error: "Errore API Chat sconosciuto"}));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply:", assistantReply);

        // Prepara per TTS
        const ttsResponse = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: assistantReply })
        });

        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({error: "Errore API TTS sconosciuto"}));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioBlob = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        playFernandaAudio(audioUrl);

    } catch (error) {
        console.error('Errore nel flusso chat/tts:', error);
        updateUI('idle', 'Errore', 'icon-mic', `Oops: ${error.message}. Riprova.`);
    }
}


function playFernandaAudio(audioUrl) {
    // ... (questa funzione rimane identica alla versione precedente che ti ho dato)
    if (currentAudio) {
        currentAudio.pause();
        if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernandaSpeaking', 'Interrompi', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking.");
        isFernandaSpeaking = false;
        if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernandaSpeaking') { 
            updateUI('idle', 'Parla Ancora', 'icon-mic', 'Tocca a te.');
        }
    };

    currentAudio.onerror = (e) => {
        console.error("Errore audio playback:", e);
        isFernandaSpeaking = false;
        if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        updateUI('idle', 'Errore Audio', 'icon-mic', 'Problema con la riproduzione audio.');
    };

    const playPromise = currentAudio.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.error("Autoplay bloccato o errore play:", error);
            isFernandaSpeaking = false;
            updateUI('idle', 'Audio Bloccato', 'icon-mic', 'Audio bloccato. Abilita autoplay o clicca per riprovare.');
            if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        });
    }
}

controlButton.addEventListener('click', () => {
    console.log("Button clicked. Current state:", currentConversationState);

    if (currentConversationState === 'idle' || currentConversationState === 'error') {
        startRecording();
    } else if (currentConversationState === 'listeningToUser') {
        // Utente clicca mentre sta parlando -> ferma l'ascolto e processa
        if (mediaRecorder && mediaRecorder.state === "recording") {
            clearTimeout(silenceTimeout); // Ferma il timer di silenzio
            mediaRecorder.stop(); // onstop gestirà il resto
        }
    } else if (currentConversationState === 'fernandaSpeaking') {
        // Utente interrompe Fernanda
        if (currentAudio) {
            currentAudio.pause();
            isFernandaSpeaking = false;
            if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        // E inizia subito ad ascoltare l'utente
        startRecording(); // L'UI si aggiornerà in mediaRecorder.onstart
    } 
    // Non fare nulla se cliccato durante processingTranscription o processingChat (pulsante disabilitato)
});

// Inizializza UI
if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Inizia', 'icon-mic', 'Pronta quando vuoi.');
} else {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Browser non supportato per audio/microfono.');
    controlButton.disabled = true;
}
