// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

// --- VAD (Voice Activity Detection) Variables ---
let audioContext;
let analyser;
let microphoneSource;
const VAD_SILENCE_THRESHOLD = 0.01;
const VAD_SILENCE_DURATION_MS = 1800;
const VAD_SPEECH_MIN_DURATION_MS = 300;
let silenceStartTime = 0;
let speaking = false;
let speechStartTime = 0;
let globalStream = null;
let vadProcessTimeout = null;

let currentTurnAudioChunks = [];
let mediaRecorderForVAD;
let recordingMimeType = '';
const baseRecordingFilename = 'user_vad_audio';

// --- Cronologia Conversazione ---
let conversationHistory = [];

// --- Stati UI e Gestione Audio Fernanda ---
let currentAudio = null;
let isFernandaSpeaking = false;
let currentConversationState = 'idle';
let isTransitioningAudio = false;

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processing_vad_chunk' || isTransitioningAudio);
    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = isTransitioningAudio;
    }
    console.log("UI Update:", state, buttonText, "Status:", statusText, "Transitioning:", isTransitioningAudio, "Button Disabled:", controlButton.disabled);
}

function getExtensionFromMimeType(mimeType) {
    if (!mimeType) return '.bin';
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    switch (typeSpecific) {
        case 'audio/wav': case 'audio/wave': return '.wav';
        case 'audio/webm': return '.webm';
        case 'audio/opus': return '.opus';
        case 'audio/mp4': return '.mp4';
        case 'audio/m4a': return '.m4a';
        case 'audio/ogg': return '.ogg';
        case 'audio/mpeg': return '.mp3';
        case 'audio/aac': return '.aac';
        default:
            console.warn(`Nessuna estensione nota per MIME type: ${mimeType}. Tentativo fallback.`);
            if (typeSpecific.startsWith('audio/x-')) {
                const potentialExt = typeSpecific.substring(8);
                if (potentialExt.length > 0 && potentialExt.length <= 4) return `.${potentialExt}`;
            }
            if (mimeType.includes('opus') && !typeSpecific.includes('webm') && !typeSpecific.includes('ogg')) return '.opus';
            return '.bin';
    }
}

async function initializeAudioProcessing() {
    console.log("Initializing audio processing...");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
        return false;
    }
    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Microphone access granted.");

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext created. Initial state:", audioContext.state);

        if (audioContext.state === 'suspended') {
            console.log("AudioContext is suspended, attempting to resume...");
            try {
                await audioContext.resume();
                console.log("AudioContext resumed successfully. New state:", audioContext.state);
            } catch (resumeError) {
                console.error("Failed to resume AudioContext:", resumeError);
            }
        }

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.minDecibels = -70;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.6;

        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);
        console.log("Audio pipeline (mic -> analyser) setup complete.");

        let preferredMimeType = '';
        const mimeTypesToTest = ['audio/wav', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac'];
        for (const mime of mimeTypesToTest) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                break;
            }
        }
        if (!preferredMimeType && MediaRecorder.isTypeSupported('')) {
            console.warn("Nessun MIME type preferito esplicito supportato. Usando default browser.");
        } else if (!preferredMimeType) {
            console.error("CRITICAL: MediaRecorder non supporta formati audio comuni.");
            updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato.');
            controlButton.disabled = true;
            cleanUpFullSession();
            return false;
        }
        recordingMimeType = preferredMimeType;
        console.log("VAD Init: Preferred MIME Type (iniziale):", recordingMimeType || "Browser Default");
        return true;
    } catch (err) {
        console.error('Error getUserMedia/AudioContext setup:', err.name, err.message, err);
        let msg = 'Errore inizializzazione microfono.';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Permesso microfono negato.';
        else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') msg = 'Nessun microfono trovato.';
        else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') msg = 'Microfono in uso o non leggibile.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        return false;
    }
}

function stopAndReleaseMediaRecorder() {
    if (mediaRecorderForVAD) {
        console.log("Stopping/releasing MediaRecorder. State:", mediaRecorderForVAD.state);
        if (mediaRecorderForVAD.state === "recording" || mediaRecorderForVAD.state === "paused") {
            try {
                mediaRecorderForVAD.stop();
                console.log("MediaRecorder.stop() called.");
            } catch (e) {
                console.warn("Error mediaRecorderForVAD.stop():", e.message, e);
            }
        }
        mediaRecorderForVAD.ondataavailable = null;
        mediaRecorderForVAD.onstart = null;
        mediaRecorderForVAD.onstop = null;
        mediaRecorderForVAD.onerror = null;
        mediaRecorderForVAD = null;
        console.log("MediaRecorder instance/listeners released.");
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream || !microphoneSource) {
        console.error("AudioContext/analyser/globalStream/microphoneSource not initialized for VAD.");
        cleanUpFullSession();
        updateUI('idle', 'Errore Avvio VAD', 'icon-mic', 'Errore critico VAD. Ricarica.');
        return;
    }
    stopAndReleaseMediaRecorder();
    isTransitioningAudio = false;
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];
    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    console.log("Attempting MediaRecorder creation. Options:", options);
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("New MediaRecorder. Requested MIME:", options.mimeType || "Default", "Actual:", mediaRecorderForVAD.mimeType);
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.warn(`MediaRecorder using "${mediaRecorderForVAD.mimeType}", requested "${recordingMimeType}". Updating.`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        } else if (!mediaRecorderForVAD.mimeType && recordingMimeType) {
            console.warn(`MediaRecorder no effective MIME. Sticking with: "${recordingMimeType}".`);
        } else if (!mediaRecorderForVAD.mimeType && !recordingMimeType) {
            console.error("CRITICAL: MediaRecorder no effective MIME, no default. Recording may fail.");
        }
        console.log("Effective global recordingMimeType:", recordingMimeType);
    } catch (e) {
        console.error("Error creating MediaRecorder:", e.name, e.message, e, "Options:", options);
        isTransitioningAudio = false;
        cleanUpFullSession();
        let errorMsg = 'Errore MediaRecorder.';
        if (e.name === 'SecurityError') errorMsg = 'Errore sicurezza MediaRecorder.';
        if (e.name === 'NotSupportedError' || e.message.toLowerCase().includes('mime type')) errorMsg = 'Formato audio (MIME) non supportato.';
        updateUI('idle', 'Errore Registratore', 'icon-mic', errorMsg);
        return;
    }
    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) currentTurnAudioChunks.push(event.data);
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder.onstart. Effective MIME:", mediaRecorderForVAD.mimeType);
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.log(`Updating global recordingMimeType (onstart) to: "${mediaRecorderForVAD.mimeType}"`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
        isTransitioningAudio = false;
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder.onstop. Chunks:", currentTurnAudioChunks.length, "Size:", currentTurnAudioChunks.reduce((s, b) => s + b.size, 0), "bytes");
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error ? event.error.name : "Unknown", event.error ? event.error.message : "No message", event.error);
        isTransitioningAudio = false;
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema registrazione. Riprova.');
        stopAndReleaseMediaRecorder();
    };
    try {
        mediaRecorderForVAD.start(500);
        console.log("MediaRecorder.start(500) called.");
    } catch (e) {
        console.error("Error MediaRecorder.start():", e.name, e.message, e);
        isTransitioningAudio = false;
        cleanUpFullSession();
        updateUI('idle', 'Errore Avvio Reg.', 'icon-mic', 'Impossibile avviare registrazione.');
        return;
    }
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
}

function cleanUpFullSession() {
    console.log("Cleaning up full VAD session...");
    isTransitioningAudio = false;
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
        console.log("VAD process loop cancelled.");
    }
    stopAndReleaseMediaRecorder();
    if (microphoneSource) {
        try {
            microphoneSource.disconnect();
            console.log("Microphone source disconnected.");
        } catch (e) {
            console.warn("Error disconnecting microphone source:", e.message);
        }
        microphoneSource = null;
    }
    analyser = null;
    if (audioContext && audioContext.state !== 'closed') {
        console.log("Closing AudioContext. State:", audioContext.state);
        audioContext.close().then(() => {
            console.log("AudioContext closed.");
            audioContext = null;
        }).catch(e => {
            console.warn("Error closing AudioContext:", e.message, e);
            audioContext = null;
        });
    } else if (audioContext && audioContext.state === 'closed') {
        console.log("AudioContext was already closed.");
        audioContext = null;
    }
    if (globalStream) {
        globalStream.getTracks().forEach(track => {
            track.stop();
            console.log(`Track ${track.kind} (id: ${track.id}) stopped.`);
        });
        globalStream = null;
        console.log("Global media stream released.");
    }
    conversationHistory = [];
    currentTurnAudioChunks = [];
    speaking = false;
    isFernandaSpeaking = false;
    if(currentAudio) {
        currentAudio.pause();
        if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
    }
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("Sessione VAD pulita, UI resettata a idle.");
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD || mediaRecorderForVAD.state !== "recording" || isTransitioningAudio) {
        if (currentConversationState === 'listening_continuous') vadProcessTimeout = requestAnimationFrame(processAudioLoop);
        return;
    }
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += ((dataArray[i] / 128.0) - 1.0) ** 2;
    const rms = Math.sqrt(sum / dataArray.length);
    const currentTime = performance.now();
    if (rms > VAD_SILENCE_THRESHOLD) {
        if (!speaking) {
            speaking = true;
            speechStartTime = currentTime;
        }
        silenceStartTime = currentTime;
    } else {
        if (speaking) {
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;
                console.log(`VAD: End speech. Duration: ${speechDuration.toFixed(0)}ms.`);
                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = [];
                    if (isTransitioningAudio) {
                        console.warn("ProcessAudioLoop: isTransitioningAudio=true. Annullamento invio.");
                        vadProcessTimeout = requestAnimationFrame(processAudioLoop);
                        return;
                    }
                    const actualBlobMimeType = recordingMimeType || mediaRecorderForVAD?.mimeType || 'application/octet-stream';
                    const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                    const fileExtension = getExtensionFromMimeType(actualBlobMimeType);
                    const filenameForApi = `${baseRecordingFilename}${fileExtension}`;
                    console.log(`[DEBUG] ProcessAudioLoop - Invio: ${filenameForApi}, Type: ${audioBlob.type}, Size: ${audioBlob.size}`);
                    sendAudioForTranscription(audioBlob, filenameForApi);
                    return;
                } else {
                    console.log(`VAD: Parlato breve (${speechDuration.toFixed(0)}ms) o no chunk (${currentTurnAudioChunks.length}).`);
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
    console.log(`[sendAudioForTranscription] Invio: fn='${filename}', type='${audioBlob.type}', size=${audioBlob.size}`);
    if (audioBlob.size === 0) {
        console.warn("Blob audio vuoto. Riprendo ascolto.");
        statusMessage.textContent = 'Audio non rilevato. Riascolto.';
        setTimeout(resumeListeningAfterFernanda, 1000);
        return;
    }
    if (isTransitioningAudio) {
        console.warn("sendAudioForTranscription: isTransitioningAudio=true. Annullamento. Riprendo ascolto.");
        resumeListeningAfterFernanda();
        return;
    }
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo audio...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);
    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const responseBodyText = await transcribeResponse.text();
        if (!transcribeResponse.ok) {
            let errorPayload;
            try { errorPayload = JSON.parse(responseBodyText); }
            catch (e) { errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}. Resp: ${responseBodyText}` }; }
            console.error("Errore Trascrizione (Server):", transcribeResponse.status, errorPayload);
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = JSON.parse(responseBodyText);
        console.log("Whisper transcript (VAD):", transcript);
        if (!transcript || transcript.trim().length < 2) {
            statusMessage.textContent = 'Non ho colto bene. Ripeti?';
            setTimeout(resumeListeningAfterFernanda, 1500);
            return;
        }
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);
    } catch (error) {
        let displayErrorMessage = "Errore trascrizione.";
        const rawErrorMessage = error && error.message ? error.message : "Errore sconosciuto trascrizione";
        console.error('Errore sendAudioForTranscription (VAD):', rawErrorMessage, error);
        if (rawErrorMessage.toLowerCase().includes("invalid file format") || rawErrorMessage.toLowerCase().includes("format is not supported") || rawErrorMessage.includes("[OpenAI Code:")) {
            displayErrorMessage = `Errore formato audio: ${rawErrorMessage}`;
        } else {
            displayErrorMessage = rawErrorMessage;
        }
        statusMessage.textContent = `Errore: ${displayErrorMessage}. Riprova.`;
        setTimeout(resumeListeningAfterFernanda, 2000);
    }
}

async function processChatWithFernanda(transcript) {
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda pensa...');
    try {
        const chatResponse = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: transcript, history: conversationHistory }) });
        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({ error: `Errore API Chat (${chatResponse.status} ${chatResponse.statusText})` }));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply (VAD):", assistantReply);
        if (!assistantReply || assistantReply.trim() === "") {
            console.warn("Risposta Fernanda vuota.");
            statusMessage.textContent = "Fernanda non ha risposto. Riprova.";
            setTimeout(resumeListeningAfterFernanda, 1500);
            return;
        }
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        const MAX_HISTORY_TURNS = 10;
        if (conversationHistory.length > MAX_HISTORY_TURNS * 2) conversationHistory = conversationHistory.slice(conversationHistory.length - (MAX_HISTORY_TURNS * 2));
        updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda prepara audio...');
        const ttsResponse = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: assistantReply }) });
        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: `Errore API TTS (${ttsResponse.status} ${ttsResponse.statusText}) (no JSON)` }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        if (audioFernandaBlob.size === 0) {
            console.error("TTS Blob vuoto.");
            throw new Error("Audio da Fernanda vuoto (errore TTS).");
        }
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        playFernandaAudio(audioUrl);
    } catch (error) {
        console.error('Errore chat/tts (VAD):', error.message, error);
        statusMessage.textContent = `Oops, ${error.message}. Riprova.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.onended = null;
        currentAudio.onerror = null;
        if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
            console.log("Revoked old audio URL:", currentAudio.src);
        }
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');
    console.log("Attempting play Fernanda's audio:", audioUrl);
    currentAudio.onended = () => {
        console.log("Fernanda finished speaking. URL:", currentAudio.src);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
            console.log("Revoked audio URL onended:", currentAudio.src);
        }
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') resumeListeningAfterFernanda();
    };
    currentAudio.onerror = (e) => {
        console.error("Errore riproduzione audio Fernanda (VAD):", e);
        let errorMessageForUser = 'Problema audio con Fernanda.';
        if (currentAudio && currentAudio.error) {
            console.error("MediaError details:", `Code: ${currentAudio.error.code}, Message: ${currentAudio.error.message}`);
            switch (currentAudio.error.code) {
                case MediaError.MEDIA_ERR_ABORTED: errorMessageForUser = 'Riproduzione audio interrotta.'; break;
                case MediaError.MEDIA_ERR_NETWORK: errorMessageForUser = 'Errore rete riproduzione audio.'; break;
                case MediaError.MEDIA_ERR_DECODE: errorMessageForUser = 'Errore decodifica audio.'; break;
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: errorMessageForUser = 'Formato audio non supportato.'; break;
                default: errorMessageForUser = `Problema audio (${currentAudio.error.message || 'dettaglio non disp.'}).`;
            }
        }
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
            console.log("Revoked audio URL onerror:", currentAudio.src);
        }
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = `${errorMessageForUser} Riprova.`;
            setTimeout(resumeListeningAfterFernanda, 1500);
        }
    };
    currentAudio.play().then(() => {
        console.log("Audio Fernanda in riproduzione.");
    }).catch(error => {
        console.error("Errore currentAudio.play():", error.name, error.message, error);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
            console.log("Revoked audio URL on play().catch:", currentAudio.src);
        }
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            let userMessage = 'Riproduzione audio fallita.';
            if (error.name === 'NotAllowedError') userMessage = 'Audio bloccato dal browser. Interagisci e riprova.';
            else if (error.name === 'AbortError') userMessage = 'Riproduzione audio interrotta prima dell\'inizio.';
            else userMessage = `Errore play audio: ${error.name}. Riprova.`;
            statusMessage.textContent = userMessage;
            setTimeout(resumeListeningAfterFernanda, 1500);
        }
    });
}

function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda. Stato:", currentConversationState, "Stream:", !!globalStream);
    if (currentConversationState !== 'idle' && globalStream) {
        isTransitioningAudio = true;
        console.log("Impostato isTransitioningAudio = true per riprendere ascolto.");
        currentTurnAudioChunks = [];
        setTimeout(() => {
            if (!globalStream || !audioContext || !analyser || !microphoneSource) {
                console.error("Dipendenze mancanti startVAD in resumeListening (timeout).");
                isTransitioningAudio = false;
                cleanUpFullSession();
                return;
            }
            if (audioContext.state === 'suspended') {
                console.warn("AudioContext (VAD) sospeso prima di startVAD in resume. Ripresa...");
                audioContext.resume().then(() => {
                    console.log("AudioContext (VAD) ripreso in resumeListening.");
                    startVAD();
                }).catch(err => {
                    console.error("Fallimento ripresa AudioContext (VAD) in resumeListening.", err);
                    isTransitioningAudio = false;
                    cleanUpFullSession();
                });
            } else {
                startVAD();
            }
        }, 100);
    } else {
        console.log("resumeListeningAfterFernanda: sessione non attiva/valida o terminata.");
        if (!globalStream && currentConversationState !== 'idle') {
            console.warn("resumeListeningAfterFernanda: globalStream perso, stato non idle. Pulizia.");
            cleanUpFullSession();
        }
    }
}

async function handleControlButtonClick() {
    console.log("handleControlButtonClick. Stato:", currentConversationState, "isTransitioningAudio:", isTransitioningAudio);

    // Tentativo NON BLOCCANTE di sblocco audio per mobile al primo click
    if (currentConversationState === 'idle' && !window.audioPlaybackUnlockedViaInteraction) {
        console.log("Attempting non-blocking audio unlock for mobile...");
        let unlockAudioPlayer = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
        unlockAudioPlayer.volume = 0.001;
        unlockAudioPlayer.play()
            .then(() => {
                console.log("Silent audio play() initiated for unlocking.");
                window.audioPlaybackUnlockedViaInteraction = true;
            })
            .catch((err) => {
                console.warn("Silent audio play() for unlocking failed or interrupted:", err.name, err.message);
            })
            .finally(() => {
                unlockAudioPlayer = null; 
            });
    }
    
    // Resume AudioContext VAD se sospeso (importante per iOS)
    if (audioContext && audioContext.state === 'suspended') {
        console.log("AudioContext (VAD) sospeso. Tentativo resume...");
        try {
            await audioContext.resume(); // Questo await è per l'AudioContext del VAD
            console.log("AudioContext (VAD) resumed by user interaction.");
        } catch (e) {
            console.warn("Could not resume AudioContext (VAD) on click:", e);
        }
    }

    if (isTransitioningAudio) {
        console.log("handleControlButtonClick: click ignorato, isTransitioningAudio = true");
        statusMessage.textContent = "Attendere prego...";
        return;
    }

    if (currentConversationState === 'idle') {
        isTransitioningAudio = true;
        updateUI('idle', 'Avvio...', 'icon-mic', 'Inizializzazione audio...');
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD(); // startVAD resetterà isTransitioningAudio
        } else {
            isTransitioningAudio = false;
            // initializeAudioProcessing dovrebbe aver aggiornato l'UI
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        console.log("User requested stop session.");
        isTransitioningAudio = true;
        updateUI(currentConversationState, 'Stop...', controlButton.querySelector('span').className, 'Terminazione sessione...');
        cleanUpFullSession(); // cleanUpFullSession resetterà isTransitioningAudio e UI
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        console.log("User requested interrupt Fernanda.");
        isTransitioningAudio = true;
        updateUI('fernanda_speaking_continuous', 'Stop...', 'icon-stop', 'Interrompo Fernanda...');
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        resumeListeningAfterFernanda(); // Gestirà isTransitioningAudio per il riavvio
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM caricato. User Agent:", navigator.userAgent);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error("getUserMedia non supportato.");
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
    } else if (typeof MediaRecorder === 'undefined') {
        console.error("MediaRecorder API non supportata.");
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Registrazione audio non supportata.');
        controlButton.disabled = true;
    } else {
        updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    }
    controlButton.addEventListener('click', handleControlButtonClick);
});
