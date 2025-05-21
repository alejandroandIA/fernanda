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
            
            let options = {}; // Inizia con opzioni vuote
            let recordingFilename = 'user_audio.mp4'; // Default a .mp4 se nessun tipo è specificato/supportato
            let explicitMimeType = '';

            // Prova i tipi preferiti
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                options.mimeType = 'audio/webm;codecs=opus';
                recordingFilename = 'user_audio.webm';
                explicitMimeType = options.mimeType;
            } else if (MediaRecorder.isTypeSupported('audio/wav')) {
                options.mimeType = 'audio/wav';
                recordingFilename = 'user_audio.wav';
                explicitMimeType = options.mimeType;
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) { // Fallback a mp4 se webm e wav non vanno
                options.mimeType = 'audio/mp4';
                recordingFilename = 'user_audio.mp4';
                explicitMimeType = options.mimeType;
            } else {
                // Lascia che il browser scelga il default, ma assumi mp4 per il nome file
                // perché è un output comune di default per Safari se altri non sono specificati.
                console.warn("Nessun formato preferito supportato (webm, wav, mp4). Usando default del browser, nominando come .mp4.");
                // options.mimeType non viene impostato, MediaRecorder userà il suo default
            }
            
            console.log("Using MediaRecorder options:", options, "Filename for upload:", recordingFilename);
            
            mediaRecorder = new MediaRecorder(stream, options); // Passa le opzioni (potrebbero essere vuote)
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
                
                // Determina il tipo MIME del blob: usa il tipo dal primo chunk se disponibile, 
                // altrimenti l'explicitMimeType che abbiamo tentato di impostare, 
                // o fallback a un tipo generico se MediaRecorder ha usato il suo default.
                const actualMimeType = audioChunks[0].type || explicitMimeType || 'application/octet-stream'; 
                console.log("Blob will be created with MIME type:", actualMimeType);
                const audioBlob = new Blob(audioChunks, { type: actualMimeType });
                
                const formData = new FormData();
                formData.append('audio', audioBlob, recordingFilename); 

                try {
                    const transcribeResponse = await fetch('/api/transcribe', {
                        method: 'POST',
                        body: formData
                    });

                    if (!transcribeResponse.ok) {
                        const errData = await transcribeResponse.json().catch(() => ({error: "Errore API Trascrizione"}));
                        // L'errore dettagliato viene già loggato dal backend e mostrato all'utente
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
                    console.error('Errore trascrizione (frontend):', error.message); // Logga solo il messaggio di errore qui
                    // L'errore completo dovrebbe essere visibile nella risposta di rete e loggato dal backend.
                    // Aggiorna UI con il messaggio di errore ricevuto (che potrebbe essere quello da OpenAI)
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
            if(currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        updateUI('awaitingUserInput', 'Parla Ora', 'icon-mic', 'Tocca a te.');
    }
}
// --- Le funzioni processChat e playFernandaAudio rimangono IDENTICHE alla versione precedente ---
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
// ---------------------------------------------------------------------------------------------
controlButton.addEventListener('click', startOrStopRecording);

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Inizia', 'icon-mic', 'Pronta quando vuoi.');
} else {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
}
