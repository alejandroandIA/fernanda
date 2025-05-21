// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

let mediaRecorder;
let audioChunks = [];
// Rimuoviamo per ora il silenceTimeout per semplificare, lo stop sarà manuale
// let silenceTimeout;
// const SILENCE_THRESHOLD_MS = 2000;

let currentAudio = null; // Per l'audio di risposta di Fernanda
let isFernandaSpeaking = false;
// Stati: idle, awaitingUserInput, recording, processingTranscription, processingChat, fernandaSpeaking
let currentConversationState = 'idle'; 

// Helper per aggiornare il pulsante e lo stato
function updateUI(state, buttonText, buttonIcon, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIcon}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processingTranscription' || state === 'processingChat');
    console.log("UI Update:", state, buttonText, statusText);
}

async function startOrStopRecording() {
    if (currentConversationState === 'idle' || currentConversationState === 'awaitingUserInput') {
        // --- INIZIA REGISTRAZIONE ---
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Tentativo di forzare WAV, altrimenti default (che spesso è webm/opus)
            let options = { mimeType: 'audio/wav' };
            let recordingFilename = 'user_audio.wav';

            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                console.warn(`${options.mimeType} (WAV) not supported, trying audio/webm;codecs=opus.`);
                options = { mimeType: 'audio/webm;codecs=opus' };
                recordingFilename = 'user_audio.webm';
                if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                    console.warn(`${options.mimeType} (WEBM/Opus) not supported, trying browser default.`);
                    delete options.mimeType; // Lascia che il browser scelga
                    recordingFilename = 'user_audio.unknown'; // L'estensione sarà incerta
                }
            }
            console.log("Using MediaRecorder options:", options, "Filename for upload:", recordingFilename);
            
            mediaRecorder = new MediaRecorder(stream, options);
            audioChunks = [];

            mediaRecorder.ondataavailable = event => {
                audioChunks.push(event.data);
                console.log("Audio chunk received, size:", event.data.size);
            };

            mediaRecorder.onstart = () => {
                updateUI('recording', 'Ferma Reg.', 'icon-stop', 'Sto registrando...');
            };

            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(track => track.stop());
                console.log("Recording stopped. Total chunks:", audioChunks.length);

                if (audioChunks.length === 0) {
                    updateUI('awaitingUserInput', 'Riprova', 'icon-mic', 'Nessun audio registrato.');
                    return;
                }

                updateUI('processingTranscription', 'Trascrivo...', 'icon-thinking', 'Invio audio...');
                // Usa il tipo MIME effettivo del primo chunk se disponibile, altrimenti quello delle opzioni
                const actualMimeType = audioChunks[0].type || options.mimeType || 'audio/webm';
                const audioBlob = new Blob(audioChunks, { type: actualMimeType });
                
                const formData = new FormData();
                // Usa il recordingFilename determinato prima
                formData.append('audio', audioBlob, recordingFilename); 

                try {
                    const transcribeResponse = await fetch('/api/transcribe', {
                        method: 'POST',
                        body: formData
                    });

                    if (!transcribeResponse.ok) {
                        const errData = await transcribeResponse.json().catch(() => ({error: "Errore API Trascrizione"}));
                        throw new Error(errData.transcript || errData.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
                    }
                    const { transcript } = await transcribeResponse.json();
                    console.log("Whisper transcript:", transcript);

                    if (!transcript || transcript.trim().length < 2) {
                        updateUI('awaitingUserInput', 'Riprova', 'icon-mic', 'Non ho capito. Ripeti?');
                        return;
                    }
                    processChat(transcript);
                } catch (error) {
                    console.error('Errore trascrizione (frontend):', error);
                    updateUI('awaitingUserInput', 'Errore Trasc.', 'icon-mic', `${error.message}. Riprova.`);
                }
            };
            
            mediaRecorder.start();
            console.log("MediaRecorder started, state:", mediaRecorder.state);

        } catch (err) {
            console.error('Errore getUserMedia o MediaRecorder:', err);
            let msg = 'Errore microfono.';
            if (err.name === 'NotAllowedError') msg = 'Permesso microfono negato.';
            if (err.name === 'NotFoundError') msg = 'Nessun microfono trovato.';
            updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        }

    } else if (currentConversationState === 'recording') {
        // --- FERMA REGISTRAZIONE MANUALMENTE ---
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop(); // onstop gestirà il resto
        }
    } else if (currentConversationState === 'fernandaSpeaking') {
        // --- INTERROMPI FERNANDA E PREPARATI A PARLARE ---
        if (currentAudio) {
            currentAudio.pause();
            isFernandaSpeaking = false;
            if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        // Non avviare la registrazione automaticamente qui, l'utente cliccherà di nuovo "Inizia"
        updateUI('awaitingUserInput', 'Parla Ora', 'icon-mic', 'Tocca a te.');
    }
}


async function processChat(transcript) {
    // ... (questa funzione rimane identica alla versione precedente)
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
        updateUI('awaitingUserInput', 'Errore', 'icon-mic', `Oops: ${error.message}. Riprova.`);
    }
}

function playFernandaAudio(audioUrl) {
    // ... (questa funzione rimane identica alla versione precedente)
    if (currentAudio) {
        currentAudio.pause();
        if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernandaSpeaking', 'Interrompi', 'icon-stop', 'Fernanda parla...'); // Pulsante per interrompere

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking.");
        isFernandaSpeaking = false;
        if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernandaSpeaking') { 
            updateUI('awaitingUserInput', 'Parla Ancora', 'icon-mic', 'Tocca a te.');
        }
    };

    currentAudio.onerror = (e) => {
        console.error("Errore audio playback:", e);
        isFernandaSpeaking = false;
        if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        updateUI('awaitingUserInput', 'Errore Audio', 'icon-mic', 'Problema audio. Riprova.');
    };

    const playPromise = currentAudio.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.error("Autoplay bloccato o errore play:", error);
            isFernandaSpeaking = false;
            updateUI('awaitingUserInput', 'Audio Bloccato', 'icon-mic', 'Audio bloccato. Riprova.');
            if(currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        });
    }
}

controlButton.addEventListener('click', startOrStopRecording);

// Inizializza UI
if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Inizia', 'icon-mic', 'Pronta quando vuoi.');
} else {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
}
