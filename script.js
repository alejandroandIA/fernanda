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
let recordingMimeType = ''; // Questo verrà determinato dinamicamente
const baseRecordingFilename = 'user_vad_audio';

// --- Cronologia Conversazione ---
let conversationHistory = [];

// --- Stati UI e Gestione Audio Fernanda ---
let currentAudio = null;
let isFernandaSpeaking = false;
let currentConversationState = 'idle';
let isTransitioningAudio = false; // Flag per prevenire azioni multiple durante transizioni

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    
    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = isTransitioningAudio;
    } else {
        controlButton.disabled = (state === 'processing_vad_chunk' || isTransitioningAudio);
    }
    console.log("UI Update:", state, "Button Text:", buttonText, "Status:", statusText, "Transitioning:", isTransitioningAudio, "Button Disabled:", controlButton.disabled);
}


function getExtensionFromMimeType(mimeType) {
    console.log("[getExtensionFromMimeType] Input MIME type:", mimeType);
    if (!mimeType) {
        console.warn("[getExtensionFromMimeType] MIME type nullo o vuoto, fallback a .bin");
        return '.bin';
    }
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    let extension;
    switch (typeSpecific) {
        case 'audio/wav': case 'audio/wave': extension = '.wav'; break; // Assicurati che WAV sia qui
        case 'audio/mpeg': extension = '.mp3'; break;
        case 'audio/webm': extension = '.webm'; break;
        case 'audio/opus': extension = '.opus'; break;
        case 'audio/mp4':
            extension = '.m4a';
            console.log("[getExtensionFromMimeType] audio/mp4 rilevato, usando estensione .m4a");
            break;
        case 'audio/m4a': extension = '.m4a'; break;
        case 'audio/ogg': extension = '.ogg'; break;
        case 'audio/aac': extension = '.aac'; break;
        default:
            console.warn(`[getExtensionFromMimeType] Nessuna estensione nota per MIME: ${mimeType}. Tentativo fallback.`);
            if (typeSpecific.startsWith('audio/x-')) {
                const potentialExt = typeSpecific.substring(8);
                if (potentialExt.length > 0 && potentialExt.length <= 4) {
                    extension = `.${potentialExt}`;
                    console.log(`[getExtensionFromMimeType] Fallback audio/x- a: ${extension}`);
                    break;
                }
            }
            if (mimeType.includes('opus') && !typeSpecific.includes('webm') && !typeSpecific.includes('ogg')) {
                 extension = '.opus';
                 console.log(`[getExtensionFromMimeType] MIME type include 'opus', usando .opus`);
                 break;
            }
            extension = '.bin';
            console.log(`[getExtensionFromMimeType] Fallback finale a: ${extension}`);
    }
    console.log("[getExtensionFromMimeType] Output estensione:", extension);
    return extension;
}

async function initializeAudioProcessing() {
    console.log("Initializing audio processing...");
    isTransitioningAudio = true;
    updateUI('idle', 'Avvio...', 'icon-mic', 'Inizializzazione audio...');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
        isTransitioningAudio = false;
        return false;
    }
    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Microphone access granted.");

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext created. Initial state:", audioContext.state);

        if (audioContext.state === 'suspended') {
            console.log("AudioContext is suspended, attempting to resume...");
            await audioContext.resume();
            console.log("AudioContext resumed successfully. New state:", audioContext.state);
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
        // **MODIFICA CHIAVE: audio/wav è il PRIMO TENTATIVO ASSOLUTO**
        const mimeTypesToTest = [
            'audio/wav',                // Prova WAV per primo!
            'audio/mp4',                // Poi MP4 (M4A)
            'audio/webm;codecs=opus',   // Poi WebM Opus
            'audio/ogg;codecs=opus',    // Poi OGG Opus
            'audio/mpeg',               // MP3
            'audio/aac',                // AAC
        ];
        console.log("[initializeAudioProcessing] Testing MIME types (PRIORITIZING WAV):", mimeTypesToTest);

        for (const mime of mimeTypesToTest) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                console.log(`[initializeAudioProcessing] Supported MIME type found: ${preferredMimeType}`);
                break;
            } else {
                console.log(`[initializeAudioProcessing] MIME type NOT supported: ${mime}`);
            }
        }

        if (!preferredMimeType) {
            if (MediaRecorder.isTypeSupported('')) {
                console.warn("[initializeAudioProcessing] No preferred MIME type supported. Using browser default (empty string).");
                recordingMimeType = '';
            } else {
                console.error("[initializeAudioProcessing] CRITICAL: MediaRecorder supports no common formats nor browser default.");
                updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato.');
                controlButton.disabled = true;
                cleanUpFullSession();
                return false;
            }
        } else {
            recordingMimeType = preferredMimeType;
        }

        console.log("[initializeAudioProcessing] Effective MIME Type for recording (initial):", recordingMimeType || "Browser Default");
        return true;

    } catch (err) {
        console.error('Error in initializeAudioProcessing:', err.name, err.message, err);
        let msg = 'Errore inizializzazione microfono.';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Permesso microfono negato.';
        else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') msg = 'Nessun microfono trovato.';
        else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') msg = 'Microfono in uso o non leggibile.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        isTransitioningAudio = false;
        return false;
    }
}

function stopAndReleaseMediaRecorder() {
    if (mediaRecorderForVAD) {
        console.log("Stopping/releasing MediaRecorder. State:", mediaRecorderForVAD.state);
        if (mediaRecorderForVAD.state === "recording" || mediaRecorderForVAD.state === "paused") {
            try { mediaRecorderForVAD.stop(); console.log("MediaRecorder.stop() called."); }
            catch (e) { console.warn("Error mediaRecorderForVAD.stop():", e.message, e); }
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
        console.error("startVAD: Critical audio components not initialized.");
        cleanUpFullSession();
        updateUI('idle', 'Errore Avvio VAD', 'icon-mic', 'Errore critico VAD. Ricarica.');
        return;
    }

    stopAndReleaseMediaRecorder();
    currentTurnAudioChunks = [];
    speaking = false;
    silenceStartTime = performance.now();

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    console.log("[startVAD] Attempting MediaRecorder creation. Options:", options);

    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("[startVAD] New MediaRecorder. Requested MIME:", options.mimeType || "Default", "Actual MediaRecorder.mimeType:", mediaRecorderForVAD.mimeType);

        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.warn(`[startVAD] MediaRecorder is using "${mediaRecorderForVAD.mimeType}", different from requested/global "${recordingMimeType}". Updating global recordingMimeType.`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        } else if (!mediaRecorderForVAD.mimeType && !recordingMimeType) {
            console.error("[startVAD] CRITICAL: MediaRecorder has no effective MIME type, and no default was specified.");
        }
        console.log("[startVAD] Effective global recordingMimeType for this session:", recordingMimeType);

    } catch (e) {
        console.error("Error creating MediaRecorder:", e.name, e.message, "Options:", options);
        let errorMsg = 'Errore MediaRecorder.';
        if (e.name === 'SecurityError') errorMsg = 'Errore sicurezza MediaRecorder.';
        else if (e.name === 'NotSupportedError' || e.message.toLowerCase().includes('mime type')) errorMsg = `Formato audio (${recordingMimeType || 'default'}) non supportato.`;
        updateUI('idle', 'Errore Registratore', 'icon-mic', errorMsg);
        cleanUpFullSession();
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) currentTurnAudioChunks.push(event.data);
    };

    mediaRecorderForVAD.onstart = () => {
        console.log("[MediaRecorder.onstart] Triggered. Effective MediaRecorder.mimeType:", mediaRecorderForVAD.mimeType);
        isTransitioningAudio = false;
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    };

    mediaRecorderForVAD.onstop = () => {
        console.log("[MediaRecorder.onstop] Triggered. Chunks collected:", currentTurnAudioChunks.length, "Total size:", currentTurnAudioChunks.reduce((s, b) => s + b.size, 0), "bytes");
    };

    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error ? event.error.name : "Unknown", event.error ? event.error.message : "No message", event);
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema registrazione. Riprova.');
        stopAndReleaseMediaRecorder();
        isTransitioningAudio = false;
    };

    try {
        mediaRecorderForVAD.start(500);
        console.log("[startVAD] MediaRecorder.start(500) called.");
    } catch (e) {
        console.error("Error MediaRecorder.start():", e.name, e.message, e);
        updateUI('idle', 'Errore Avvio Reg.', 'icon-mic', 'Impossibile avviare registrazione.');
        cleanUpFullSession();
        return;
    }

    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
}

function cleanUpFullSession() {
    console.log("Cleaning up full VAD session...");
    isTransitioningAudio = true;

    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
        console.log("VAD process loop cancelled.");
    }
    stopAndReleaseMediaRecorder();
    if (microphoneSource) {
        try { microphoneSource.disconnect(); console.log("Microphone source disconnected."); }
        catch (e) { console.warn("Error disconnecting microphone source:", e.message); }
        microphoneSource = null;
    }
    analyser = null;
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().then(() => {
            console.log("AudioContext closed.");
            audioContext = null;
        }).catch(e => {
            console.warn("Error closing AudioContext:", e.message, e);
            audioContext = null;
        });
    } else if (audioContext) {
        audioContext = null;
    }
    if (globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
        console.log("Global media stream released.");
    }
    conversationHistory = [];
    currentTurnAudioChunks = [];
    speaking = false;
    isFernandaSpeaking = false;
    if(currentAudio) {
        currentAudio.pause();
        if (currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
    }
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("Sessione VAD pulita, UI resettata a idle.");
    isTransitioningAudio = false;
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD || mediaRecorderForVAD.state !== "recording" || isTransitioningAudio) {
        if (currentConversationState === 'listening_continuous' && !isTransitioningAudio && vadProcessTimeout) {
             requestAnimationFrame(processAudioLoop);
        }
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
                        console.warn("processAudioLoop: isTransitioningAudio=true. Annullamento invio audio.");
                        requestAnimationFrame(processAudioLoop);
                        return;
                    }
                    
                    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo audio...');
                    isTransitioningAudio = true;

                    let actualMimeTypeForBlob = recordingMimeType || mediaRecorderForVAD?.mimeType || 'application/octet-stream';
                    const determinedFileExtension = getExtensionFromMimeType(actualMimeTypeForBlob);
                    
                    if (determinedFileExtension === '.m4a' && !actualMimeTypeForBlob.startsWith('audio/mp4') && !actualMimeTypeForBlob.startsWith('audio/m4a')) {
                        actualMimeTypeForBlob = 'audio/mp4';
                    } else if (determinedFileExtension === '.wav' && !actualMimeTypeForBlob.startsWith('audio/wav')) {
                        actualMimeTypeForBlob = 'audio/wav'; // Assicura che se l'estensione è .wav, il tipo sia audio/wav
                    }

                    const filenameForApi = `${baseRecordingFilename}${determinedFileExtension}`;

                    console.log(`[processAudioLoop] Preparazione invio. Globale MIME: "${recordingMimeType}", Recorder MIME: "${mediaRecorderForVAD?.mimeType}", Tipo per Blob: "${actualMimeTypeForBlob}", Estensione: "${determinedFileExtension}", Filename: "${filenameForApi}"`);
                    
                    const audioBlob = new Blob(chunksToSend, { type: actualMimeTypeForBlob });
                    console.log(`[processAudioLoop] Blob creato. Size: ${audioBlob.size}, Effective Type: ${audioBlob.type}`);

                    if (audioBlob.size === 0) {
                        console.warn("[processAudioLoop] Blob audio vuoto. Non invio.");
                        statusMessage.textContent = 'Audio non rilevato. Riascolto.';
                        isTransitioningAudio = false;
                        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
                        return;
                    }
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
    console.log(`[sendAudioForTranscription] Invio. Filename='${filename}', Blob Type='${audioBlob.type}', Size=${audioBlob.size}`);

    const formData = new FormData();
    formData.append('audio', audioBlob, filename);
    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const responseBodyText = await transcribeResponse.text();
        if (!transcribeResponse.ok) {
            let errorPayload;
            try { errorPayload = JSON.parse(responseBodyText); }
            catch (e) { errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}. Server: ${responseBodyText}` }; }
            console.error("[sendAudioForTranscription] Errore Trascrizione (Server):", transcribeResponse.status, errorPayload);
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = JSON.parse(responseBodyText);
        console.log("[sendAudioForTranscription] Whisper transcript:", transcript);
        if (!transcript || transcript.trim().length < 2) {
            statusMessage.textContent = 'Non ho colto bene. Ripeti?';
            isTransitioningAudio = false;
            if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
            return;
        }
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);
    } catch (error) {
        let displayErrorMessage = "Errore trascrizione.";
        const rawErrorMessage = error?.message || "Errore sconosciuto trascrizione";
        console.error('[sendAudioForTranscription] Errore:', rawErrorMessage, error);
        if (rawErrorMessage.toLowerCase().includes("invalid file format") || 
            rawErrorMessage.toLowerCase().includes("format is not supported") ||
            rawErrorMessage.includes("[OpenAI Code:")) {
            displayErrorMessage = `Errore formato audio: ${rawErrorMessage}`; 
        } else {
            displayErrorMessage = rawErrorMessage;
        }
        statusMessage.textContent = `${displayErrorMessage}. Riprova.`;
        isTransitioningAudio = false;
        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
    }
}

async function processChatWithFernanda(transcript) {
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda pensa...');
    try {
        const chatResponse = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: transcript, history: conversationHistory }) });
        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({ error: `Errore API Chat (${chatResponse.status})` }));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        if (!assistantReply || assistantReply.trim() === "") {
            statusMessage.textContent = "Fernanda non ha risposto. Riprova.";
            isTransitioningAudio = false;
            if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
            return;
        }
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

        updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda prepara audio...');
        const ttsResponse = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: assistantReply }) });
        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: `Errore API TTS (${ttsResponse.status})` }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        if (audioFernandaBlob.size === 0) throw new Error("Audio da Fernanda vuoto.");
        
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        playFernandaAudio(audioUrl);
    } catch (error) {
        console.error('Errore chat/tts:', error.message, error);
        statusMessage.textContent = `Oops, ${error.message}. Riprova.`;
        isTransitioningAudio = false;
        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
    }
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        console.log("Fernanda finished speaking.");
        isFernandaSpeaking = false;
        if (currentAudio?.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            isTransitioningAudio = false;
            resumeListeningAfterFernanda();
        }
    };
    currentAudio.onerror = (e) => {
        console.error("Errore riproduzione audio Fernanda:", e, currentAudio?.error);
        isFernandaSpeaking = false;
        if (currentAudio?.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        let errMsg = 'Problema audio con Fernanda.';
        if (currentAudio?.error) errMsg += ` (Codice: ${currentAudio.error.code})`;
        statusMessage.textContent = `${errMsg} Riprova.`;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            isTransitioningAudio = false;
            resumeListeningAfterFernanda();
        }
    };
    currentAudio.play().catch(error => {
        console.error("Errore currentAudio.play():", error);
        isFernandaSpeaking = false;
        if (currentAudio?.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        statusMessage.textContent = `Riproduzione audio Fernanda fallita. Riprova.`;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            isTransitioningAudio = false;
            resumeListeningAfterFernanda();
        }
    });
}

function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda. Stato:", currentConversationState, "Stream:", !!globalStream, "isTransitioningAudio:", isTransitioningAudio);
    if (currentConversationState === 'idle' || !globalStream) {
        console.log("resumeListeningAfterFernanda: Sessione terminata o stream perso. Non riprendo.");
        if (currentConversationState !== 'idle') cleanUpFullSession();
        isTransitioningAudio = false;
        return;
    }
    if (isTransitioningAudio && currentConversationState !== 'fernanda_speaking_continuous') {
        console.log("resumeListeningAfterFernanda: Già in transizione, non riavvio VAD.");
        return;
    }

    isTransitioningAudio = true;
    console.log("Impostato isTransitioningAudio = true per riprendere ascolto.");
    currentTurnAudioChunks = [];
    
    setTimeout(() => {
        if (!globalStream || !audioContext || audioContext.state === 'closed' || !analyser || !microphoneSource) {
            console.error("resumeListeningAfterFernanda: Dipendenze audio mancanti o chiuse. Pulizia.");
            cleanUpFullSession();
            return;
        }
        if (audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log("AudioContext ripreso in resumeListening.");
                startVAD();
            }).catch(err => {
                console.error("Fallimento ripresa AudioContext in resumeListening.", err);
                cleanUpFullSession();
            });
        } else {
            startVAD();
        }
    }, 100);
}

async function handleControlButtonClick() {
    console.log("handleControlButtonClick. Stato:", currentConversationState, "isTransitioningAudio:", isTransitioningAudio);

    if (isTransitioningAudio && currentConversationState !== 'idle' && currentConversationState !== 'fernanda_speaking_continuous') {
        console.log("Click ignorato: transizione in corso e non in idle/fernanda_speaking.");
        statusMessage.textContent = "Attendere prego...";
        return;
    }

    if (!window.audioPlaybackUnlockedViaInteraction) {
        let unlockAudio = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
        unlockAudio.volume = 0.001;
        unlockAudio.play().then(() => window.audioPlaybackUnlockedViaInteraction = true).catch(() => {});
    }
    
    if (audioContext && audioContext.state === 'suspended') {
        try { await audioContext.resume(); console.log("AudioContext ripreso da interazione."); }
        catch (e) { console.warn("Impossibile riprendere AudioContext:", e); }
    }

    if (currentConversationState === 'idle') {
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD();
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        console.log("User requested stop session (from listening/processing).");
        isTransitioningAudio = true;
        updateUI(currentConversationState, 'Stop...', controlButton.querySelector('span').className, 'Terminazione...');
        cleanUpFullSession();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        console.log("User requested interrupt Fernanda.");
        isTransitioningAudio = true;
        updateUI('fernanda_speaking_continuous', 'Stop...', 'icon-stop', 'Interrompo Fernanda...');
        if (currentAudio) {
            currentAudio.pause();
            if (currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        resumeListeningAfterFernanda();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM caricato. User Agent:", navigator.userAgent);
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined')) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic o Registrazione non supportati.');
        controlButton.disabled = true;
    } else {
        updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    }
    controlButton.addEventListener('click', handleControlButtonClick);
});
