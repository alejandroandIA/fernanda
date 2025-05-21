// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

// --- VAD (Voice Activity Detection) Variables ---
let audioContext;
let analyser;
let microphoneSource;
const VAD_SILENCE_THRESHOLD = 0.01; // Da tarare: sensibilità al volume (0-1)
const VAD_SILENCE_DURATION_MS = 1800; // Millisecondi di silenzio prima di considerare l'utente aver finito
const VAD_SPEECH_MIN_DURATION_MS = 300; // Minima durata del parlato per inviare
let silenceStartTime = 0;
let speaking = false;
let speechStartTime = 0;
let globalStream = null;
let vadProcessTimeout = null;

let currentTurnAudioChunks = [];
let mediaRecorderForVAD;
let recordingMimeType = ''; // MIME type effettivo o preferito per MediaRecorder
const baseRecordingFilename = 'user_vad_audio'; // Nome base, l'estensione sarà aggiunta dinamicamente

// --- Cronologia Conversazione ---
let conversationHistory = [];

// --- Stati UI e Gestione Audio Fernanda ---
let currentAudio = null;
let isFernandaSpeaking = false;
let currentConversationState = 'idle';

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processing_vad_chunk');
    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = false;
    }
    console.log("UI Update:", state, buttonText, statusText);
}

// Funzione helper per ottenere l'estensione dal MIME type
function getExtensionFromMimeType(mimeType) {
    if (!mimeType) return '.bin'; // Fallback
    const typeSpecific = mimeType.split(';')[0].toLowerCase(); // Rimuove parametri come ';codecs=opus'
    switch (typeSpecific) {
        case 'audio/webm': return '.webm';
        case 'audio/opus': return '.opus'; // Whisper supporta .opus direttamente
        case 'audio/mp4': return '.mp4';   // Spesso M4A (AAC in MP4 container)
        case 'audio/m4a': return '.m4a';
        case 'audio/wav':
        case 'audio/wave': return '.wav';  // Alcuni browser usano audio/wave
        case 'audio/ogg': return '.ogg';   // Spesso Opus o Vorbis in OGG container
        case 'audio/mpeg': return '.mp3';
        case 'audio/aac': return '.aac';   // Whisper supporta AAC
        default:
            console.warn(`Nessuna estensione nota per MIME type: ${mimeType}. Tentativo di fallback.`);
            // Tentativo di estrarre qualcosa se assomiglia a audio/x-estensione
            if (typeSpecific.startsWith('audio/x-')) {
                const potentialExt = typeSpecific.substring(8);
                if (potentialExt.length > 0 && potentialExt.length <= 4) return `.${potentialExt}`;
            }
            return '.bin'; // Fallback finale se non riconosciuto
    }
}

async function initializeAudioProcessing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
        return false;
    }

    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.minDecibels = -70;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.6;
        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);

        // Determina il MIME type preferito e l'estensione associata
        let preferredMimeType = '';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            preferredMimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) { // Spesso M4A (AAC)
            preferredMimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/wav')) {
            preferredMimeType = 'audio/wav';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
            preferredMimeType = 'audio/ogg;codecs=opus';
        } else {
            preferredMimeType = ''; // Lascia che il browser scelga
            console.warn("Nessun formato MIME preferito (webm, mp4, wav, ogg) supportato. Usando default browser.");
        }
        
        recordingMimeType = preferredMimeType; // Salva il MIME type preferito/scelto inizialmente
        const initialExtension = getExtensionFromMimeType(recordingMimeType);
        console.log("VAD Init: Preferred MIME Type:", recordingMimeType || "Browser Default", "| Initial Filename based on preference:", `${baseRecordingFilename}${initialExtension}`);
        return true;

    } catch (err) {
        console.error('Errore getUserMedia o AudioContext:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError') msg = 'Permesso microfono negato.';
        if (err.name === 'NotFoundError') msg = 'Nessun microfono trovato.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        return false;
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream) {
        console.error("AudioContext non inizializzato per VAD.");
        stopVAD();
        updateUI('idle', 'Errore Avvio', 'icon-mic', 'Errore avvio VAD. Ricarica.');
        return;
    }
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("MediaRecorder for VAD created. Requested MIME type:", options.mimeType || "Browser Default", "| Effective MIME type:", mediaRecorderForVAD.mimeType);

        // Aggiorna recordingMimeType con quello effettivo usato dal browser, se diverso o non specificato
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            if (recordingMimeType) { // Solo se avevamo una preferenza
                 console.warn(`MediaRecorder userà ${mediaRecorderForVAD.mimeType} invece del richiesto/preferito ${recordingMimeType}. Aggiornamento.`);
            }
            recordingMimeType = mediaRecorderForVAD.mimeType; // Assicura che recordingMimeType rifletta la realtà
        } else if (!recordingMimeType && mediaRecorderForVAD.mimeType) { // Se non avevamo preferenze e il browser ne ha scelta una
            recordingMimeType = mediaRecorderForVAD.mimeType;
            console.log(`MediaRecorder userà il default del browser: ${recordingMimeType}`);
        }


    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e, "Opzioni:", options);
        stopVAD();
        updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato dal browser o errore MediaRecorder.');
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0) {
            currentTurnAudioChunks.push(event.data);
        }
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder for VAD started. Effective MIME type:", mediaRecorderForVAD.mimeType);
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder for VAD stopped. Chunks:", currentTurnAudioChunks.length);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        stopVAD();
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema con la registrazione audio.');
    };
    mediaRecorderForVAD.start(500);

    processAudioLoop();
}

function stopVAD() {
    console.log("Tentativo di fermare VAD...");
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
    }
    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
        mediaRecorderForVAD.stop();
    }
    mediaRecorderForVAD = null;
    if (microphoneSource) {
        microphoneSource.disconnect();
        microphoneSource = null;
    }
    currentTurnAudioChunks = [];
    speaking = false;
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("VAD fermato.");
}

function cleanUpFullSession() {
    console.log("Pulizia completa della sessione VAD.");
    stopVAD();
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.warn("Errore chiusura AudioContext:", e));
        audioContext = null;
    }
    if (globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
    }
    conversationHistory = [];
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous') {
        console.log("processAudioLoop: non in ascolto, esco.");
        return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += ((dataArray[i] / 128.0) - 1.0) ** 2;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const currentTime = performance.now();

    if (rms > VAD_SILENCE_THRESHOLD) {
        if (!speaking) {
            speaking = true;
            speechStartTime = currentTime;
            console.log("VAD: Inizio parlato (RMS:", rms.toFixed(3), ")");
        }
        silenceStartTime = currentTime;
    } else {
        if (speaking) {
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                console.log("VAD: Fine parlato (RMS:", rms.toFixed(3), ", Silenzio per", (currentTime - silenceStartTime).toFixed(0), "ms)");
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;

                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    console.log("VAD: Invio audio. Durata:", speechDuration.toFixed(0), "ms. Chunks:", currentTurnAudioChunks.length);
                    
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = [];

                    let actualBlobMimeType = '';
                    if (chunksToSend.length > 0 && chunksToSend[0].type && chunksToSend[0].type !== "") {
                        actualBlobMimeType = chunksToSend[0].type;
                    } else if (mediaRecorderForVAD && mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== "") {
                        actualBlobMimeType = mediaRecorderForVAD.mimeType;
                    } else if (recordingMimeType && recordingMimeType !== "") {
                        actualBlobMimeType = recordingMimeType;
                    } else {
                        actualBlobMimeType = 'application/octet-stream';
                        console.warn("Impossibile determinare il MIME type del blob, usando application/octet-stream.");
                    }
                    
                    const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                    const fileExtension = getExtensionFromMimeType(actualBlobMimeType);
                    const filenameForApi = `${baseRecordingFilename}${fileExtension}`;

                    console.log(`VAD: Preparazione invio. Blob type: ${audioBlob.type}, Size: ${audioBlob.size}, Filename per API: ${filenameForApi}`);
                    
                    sendAudioForTranscription(audioBlob, filenameForApi);
                    return;
                } else {
                    console.log("VAD: Parlato troppo breve o nessun chunk. Durata:", speechDuration.toFixed(0), "ms. Chunks:", currentTurnAudioChunks.length);
                    currentTurnAudioChunks = [];
                }
            }
        } else {
            silenceStartTime = currentTime;
        }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) {
    if (audioBlob.size === 0) {
        console.warn("Blob audio vuoto, non invio.");
        resumeListeningAfterFernanda();
        return;
    }

    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename); // 'filename' ora ha l'estensione corretta

    try {
        const transcribeResponse = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });

        if (!transcribeResponse.ok) {
            const errData = await transcribeResponse.json().catch(() => ({ error: "Errore API Trascrizione (no JSON)" }));
            // L'errore specifico "The audio file could not be decoded..." viene da qui se il server lo passa
            throw new Error(errData.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = await transcribeResponse.json();
        console.log("Whisper transcript (VAD):", transcript);

        if (!transcript || transcript.trim().length < 2) {
            statusMessage.textContent = 'Non ho capito. Ripeti pure.';
            setTimeout(resumeListeningAfterFernanda, 1000);
            return;
        }
        
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);

    } catch (error) {
        console.error('Errore trascrizione (VAD):', error.message);
        // L'errore "400 The audio file could not be decoded..." sarà parte di error.message se il backend lo propaga correttamente
        statusMessage.textContent = `Errore: ${error.message}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

async function processChatWithFernanda(transcript) {
    statusMessage.textContent = 'Fernanda pensa...';
    try {
        const chatResponse = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: transcript, history: conversationHistory })
        });
        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({ error: "Errore API Chat (no JSON)" }));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply (VAD):", assistantReply);
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        const MAX_HISTORY_LENGTH = 20; 
        if (conversationHistory.length > MAX_HISTORY_LENGTH) {
            conversationHistory = conversationHistory.slice(conversationHistory.length - MAX_HISTORY_LENGTH);
        }
        const ttsResponse = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: assistantReply })
        });
        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: "Errore API TTS (no JSON)" }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        playFernandaAudio(audioUrl);
    } catch (error) {
        console.error('Errore nel flusso chat/tts (VAD):', error);
        statusMessage.textContent = `Oops: ${error.message}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');
    currentAudio.onended = () => {
        console.log("Fernanda finished speaking (VAD).");
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            resumeListeningAfterFernanda();
        }
    };
    currentAudio.onerror = (e) => {
        console.error("Errore audio playback (VAD):", e);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = 'Problema audio. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    };
    currentAudio.play().catch(error => {
        console.error("Autoplay bloccato o errore play (VAD):", error);
        if (isFernandaSpeaking) {
            isFernandaSpeaking = false;
            statusMessage.textContent = 'Audio bloccato. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
        if (currentAudio && currentAudio.src) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
    });
}

function resumeListeningAfterFernanda() {
    if (['idle', 'listening_continuous', 'fernanda_speaking_continuous'].includes(currentConversationState)) {
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop-session', 'Tocca a te...');
        if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") {
            currentTurnAudioChunks = [];
            mediaRecorderForVAD.start(500);
        }
        vadProcessTimeout = requestAnimationFrame(processAudioLoop);
    }
}

async function handleControlButtonClick() {
    if (currentConversationState === 'idle') {
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD();
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        cleanUpFullSession();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
            if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        resumeListeningAfterFernanda();
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
} else {
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}
