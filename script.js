// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

let mediaRecorder;
let audioChunks = [];

let currentAudio = null;
let isFernandaSpeaking = false;
let currentConversationState = 'idle';

function updateUI(state, buttonText, buttonIcon, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIcon}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processingTranscription' || state === 'processingChat');
    console.log("UI Update:", state, buttonText, statusText);
}

async function startOrStopRecording() {
    if (currentConversationState === 'idle' || currentConversationState === 'awaitingUserInput') {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            let options = {};
            let recordingFilename = 'user_audio.mp4'; // Default, può essere sovrascritto
            let explicitMimeType = ''; // MIME type esplicito che tentiamo di impostare

            // Tenta i formati preferiti, privilegiando quelli più comuni e supportati
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                options.mimeType = 'audio/webm;codecs=opus';
                recordingFilename = 'user_audio.webm';
                explicitMimeType = options.mimeType;
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) { // Spesso M4A (AAC in MP4), ben supportato
                options.mimeType = 'audio/mp4';
                recordingFilename = 'user_audio.mp4';
                explicitMimeType = options.mimeType;
            } else if (MediaRecorder.isTypeSupported('audio/wav')) {
                options.mimeType = 'audio/wav';
                recordingFilename = 'user_audio.wav';
                explicitMimeType = options.mimeType;
            } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') || MediaRecorder.isTypeSupported('audio/ogg')) {
                options.mimeType = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : 'audio/ogg';
                recordingFilename = 'user_audio.ogg';
                explicitMimeType = options.mimeType;
            } else {
                console.warn("Nessun formato preferito (webm, mp4, wav, ogg) supportato. Usando default del browser. Il nome file sarà 'user_audio.mp4' ma potrebbe essere aggiornato in base al MIME type effettivo.");
                // options.mimeType non viene impostato, MediaRecorder userà il suo default.
                // recordingFilename resta 'user_audio.mp4' come ipotesi iniziale.
            }

            console.log("Using MediaRecorder options:", options, "Initial filename for upload:", recordingFilename);

            mediaRecorder = new MediaRecorder(stream, options);
            audioChunks = [];

            mediaRecorder.ondataavailable = event => {
                audioChunks.push(event.data);
                console.log("Audio chunk received, size:", event.data.size, "type:", event.data.type);
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

                const actualMimeType = audioChunks[0].type || explicitMimeType || 'application/octet-stream';
                console.log("Blob will be created with MIME type:", actualMimeType);
                const audioBlob = new Blob(audioChunks, { type: actualMimeType });

                // Determina il nome del file finale, privilegiando l'estensione dal actualMimeType se affidabile
                let finalFilename = recordingFilename; // Default al nome file determinato durante l'init di MediaRecorder

                if (actualMimeType && actualMimeType !== 'application/octet-stream' && actualMimeType.startsWith('audio/')) {
                    let extension = actualMimeType.split('/')[1];
                    if (extension) {
                        extension = extension.split(';')[0].toLowerCase(); // Rimuovi parametri (es. ;codecs=opus) e normalizza
                        
                        const whisperSupportedExtensions = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'];
                        
                        if (whisperSupportedExtensions.includes(extension)) {
                            finalFilename = `user_audio.${extension}`;
                            console.log(`Using filename based on actualMIMEType (${actualMimeType}): ${finalFilename}`);
                        } else {
                            console.warn(`Derived extension '${extension}' from MIME type '${actualMimeType}' is not in Whisper's explicit supported list. Using pre-determined filename: ${recordingFilename}`);
                            finalFilename = recordingFilename; // Fallback al nome file basato su isTypeSupported
                        }
                    }
                }
                
                const formData = new FormData();
                formData.append('audio', audioBlob, finalFilename); // Usa il nome file più accurato

                try {
                    const transcribeResponse = await fetch('/api/transcribe', {
                        method: 'POST',
                        body: formData
                    });

                    if (!transcribeResponse.ok) {
                        const errData = await transcribeResponse.json().catch(() => ({ error: "Errore API Trascrizione" }));
                        throw new Error(errData.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
                    }
                    const { transcript } = await transcribeResponse.json();
                    console.log("Whisper transcript:", transcript);

                    if (!transcript || transcript.trim().length < 2) {
                        updateUI('awaitingUserInput', 'Riprova', 'icon-mic', 'Non ho capito. Ripeti?');
                        return;
                    }
                    processChat(transcript);
                } catch (error) {
                    console.error('Errore trascrizione (frontend):', error.message);
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
        if (mediaRecorder && mediaRecorder.state === "recording") {
            mediaRecorder.stop();
        }
    } else if (currentConversationState === 'fernandaSpeaking') {
        if (currentAudio) {
            currentAudio.pause();
            isFernandaSpeaking = false;
            if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        updateUI('awaitingUserInput', 'Parla Ora', 'icon-mic', 'Tocca a te.');
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
            const errData = await chatResponse.json().catch(() => ({ error: "Errore API Chat sconosciuto" }));
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
            const errData = await ttsResponse.json().catch(() => ({ error: "Errore API TTS sconosciuto" }));
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
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernandaSpeaking', 'Interrompi', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking.");
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernandaSpeaking') {
            updateUI('awaitingUserInput', 'Parla Ancora', 'icon-mic', 'Tocca a te.');
        }
    };

    currentAudio.onerror = (e) => {
        console.error("Errore audio playback:", e);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        updateUI('awaitingUserInput', 'Errore Audio', 'icon-mic', 'Problema audio. Riprova.');
    };

    const playPromise = currentAudio.play();
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            console.error("Autoplay bloccato o errore play:", error);
            // Non reimpostare a 'awaitingUserInput' se l'utente ha interrotto
            if (isFernandaSpeaking) {
                isFernandaSpeaking = false;
                updateUI('awaitingUserInput', 'Audio Bloccato', 'icon-mic', 'Audio bloccato. Riprova.');
            }
            if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        });
    }
}

controlButton.addEventListener('click', startOrStopRecording);

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Inizia', 'icon-mic', 'Pronta quando vuoi.');
} else {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
}
