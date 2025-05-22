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
    console.log("[getExtensionFromMimeType] Input MIME type:", mimeType);
    if (!mimeType) {
        console.warn("[getExtensionFromMimeType] MIME type nullo o vuoto, fallback a .bin");
        return '.bin';
    }
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    let extension;
    switch (typeSpecific) {
        case 'audio/wav': case 'audio/wave': extension = '.wav'; break;
        case 'audio/webm': extension = '.webm'; break;
        case 'audio/opus': extension = '.opus'; break;
        case 'audio/mp4': 
            extension = '.mp4'; // MODIFICA: usa .mp4 per audio/mp4
            console.log("[getExtensionFromMimeType] audio/mp4 rilevato, usando estensione .mp4");
            break;
        case 'audio/m4a': extension = '.m4a'; break; // Se MIME è esplicitamente audio/m4a
        case 'audio/ogg': extension = '.ogg'; break;
        case 'audio/mpeg': extension = '.mp3'; break;
        case 'audio/aac': extension = '.aac'; break; // OpenAI non elenca .aac, ma m4a/mp4 (AAC) sì.
        default:
            console.warn(`[getExtensionFromMimeType] Nessuna estensione nota per MIME: ${typeSpecific}. Tentativo fallback.`);
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
                 console.log(`[getExtensionFromMimeType] MIME type include 'opus' non in webm/ogg, usando .opus`);
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
            await audioContext.resume().catch(resumeError => console.error("Failed to resume AudioContext:", resumeError));
            console.log("AudioContext resumed (o tentato). New state:", audioContext.state);
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
        // Lista AFFINATA: priorità a WAV, poi formati compressi comuni e ben supportati
        const mimeTypesToTest = [
            'audio/wav',                // Massima compatibilità, OpenAI lo supporta bene
            'audio/webm;codecs=opus',   // Buona qualità/compressione, supportato
            'audio/ogg;codecs=opus',    // Simile a webm/opus, supportato
            'audio/mp4',                // Per AAC su iOS/altri, supportato (useremo estensione .mp4)
            'audio/aac',                // Meno comune per MediaRecorder ma teoricamente possibile
            'audio/mpeg',               // Per MP3, supportato
        ];
        console.log("[initializeAudioProcessing] Testando MIME types:", mimeTypesToTest);

        for (const mime of mimeTypesToTest) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                console.log(`[initializeAudioProcessing] MIME type supportato trovato: ${preferredMimeType}`);
                break;
            } else {
                console.log(`[initializeAudioProcessing] MIME type NON supportato: ${mime}`);
            }
        }
        
        if (!preferredMimeType && MediaRecorder.isTypeSupported('')) {
            console.warn("[initializeAudioProcessing] Nessun MIME type preferito esplicito supportato. Si userà il default del browser (lasciando recordingMimeType vuoto per ora).");
            recordingMimeType = ''; 
        } else if (!preferredMimeType) {
            console.error("[initializeAudioProcessing] CRITICAL: MediaRecorder non sembra supportare alcun formato audio comune né un default vuoto.");
            updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato per la registrazione.');
            controlButton.disabled = true;
            cleanUpFullSession();
            return false;
        } else {
            recordingMimeType = preferredMimeType;
        }
        
        console.log("[initializeAudioProcessing] VAD Init: Initial recordingMimeType:", recordingMimeType || "Browser Default");
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
    console.log("[startVAD] Attempting MediaRecorder creation. Requested options:", options);

    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("[startVAD] New MediaRecorder created. Requested MIME:", options.mimeType || "Browser Default");
        
        if (mediaRecorderForVAD.mimeType) {
            console.log(`[startVAD] MediaRecorder effective MIME type: "${mediaRecorderForVAD.mimeType}". Updating global recordingMimeType.`);
            recordingMimeType = mediaRecorderForVAD.mimeType; 
        } else {
            console.warn("[startVAD] MediaRecorder did not report an effective MIME type. Global recordingMimeType remains:", recordingMimeType || "Empty");
        }
        console.log("[startVAD] Effective global recordingMimeType for this session:", recordingMimeType || "Not yet determined/browser default");

    } catch (e) {
        console.error("Error creating MediaRecorder:", e.name, e.message, e, "Options:", options);
        isTransitioningAudio = false;
        cleanUpFullSession();
        let errorMsg = 'Errore MediaRecorder.';
        if (e.name === 'SecurityError') errorMsg = 'Errore sicurezza MediaRecorder.';
        if (e.name === 'NotSupportedError' || (e.message && e.message.toLowerCase().includes('mime type'))) errorMsg = 'Formato audio (MIME) non supportato.';
        updateUI('idle', 'Errore Registratore', 'icon-mic', errorMsg);
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) currentTurnAudioChunks.push(event.data);
    };

    mediaRecorderForVAD.onstart = () => {
        console.log("[MediaRecorder.onstart] Triggered. Effective MediaRecorder.mimeType:", mediaRecorderForVAD.mimeType);
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.log(`[MediaRecorder.onstart] Updating global recordingMimeType from "${recordingMimeType}" to "${mediaRecorderForVAD.mimeType}"`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
        isTransitioningAudio = false;
    };

    mediaRecorderForVAD.onstop = () => {
        console.log("[MediaRecorder.onstop] Triggered. Chunks collected:", currentTurnAudioChunks.length, "Total (approx):", currentTurnAudioChunks.reduce((s, b) => s + b.size, 0), "bytes");
    };

    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error ? event.error.name : "Unknown", event.error ? event.error.message : "No message", event.error);
        isTransitioningAudio = false;
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema registrazione. Riprova.');
        stopAndReleaseMediaRecorder();
    };

    try {
        mediaRecorderForVAD.start(500); 
        console.log("[startVAD] MediaRecorder.start(500) called.");
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
    if (vadProcessTimeout) { cancelAnimationFrame(vadProcessTimeout); vadProcessTimeout = null; console.log("VAD process loop cancelled."); }
    stopAndReleaseMediaRecorder();
    if (microphoneSource) { try { microphoneSource.disconnect(); console.log("Microphone source disconnected."); } catch (e) { console.warn("Error disconnecting microphone source:", e.message); } microphoneSource = null; }
    analyser = null;
    if (audioContext && audioContext.state !== 'closed') {
        console.log("Closing AudioContext. State:", audioContext.state);
        audioContext.close().then(() => { console.log("AudioContext closed."); audioContext = null; })
        .catch(e => { console.warn("Error closing AudioContext:", e.message, e); audioContext = null; });
    } else if (audioContext && audioContext.state === 'closed') { console.log("AudioContext was already closed."); audioContext = null; }
    if (globalStream) { globalStream.getTracks().forEach(track => { track.stop(); console.log(`Track ${track.kind} (id: ${track.id}) stopped.`); }); globalStream = null; console.log("Global media stream released."); }
    conversationHistory = []; currentTurnAudioChunks = []; speaking = false; isFernandaSpeaking = false;
    if(currentAudio) { currentAudio.pause(); if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src); currentAudio = null; }
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
        if (!speaking) { speaking = true; speechStartTime = currentTime; }
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
                    if (isTransitioningAudio) { console.warn("ProcessAudioLoop: isTransitioningAudio=true. Annullamento invio."); vadProcessTimeout = requestAnimationFrame(processAudioLoop); return; }

                    // --- LOGICA MIGLIORATA PER MIME TYPE E ESTENSIONE ---
                    let determinedMimeType = recordingMimeType || mediaRecorderForVAD?.mimeType;
                    let finalMimeTypeForBlob;
                    let finalFileExtension;

                    console.log(`[processAudioLoop] Initial determinedMimeType: "${determinedMimeType}" (Global recMIME: "${recordingMimeType}", MediaRec actual MIME: "${mediaRecorderForVAD?.mimeType}")`);

                    const problematicMimeTypes = [null, undefined, '', 'application/octet-stream', 'audio/data'];
                    if (problematicMimeTypes.includes(determinedMimeType) || (typeof determinedMimeType === 'string' && determinedMimeType.trim() === '')) {
                        finalMimeTypeForBlob = 'audio/wav'; // Fallback forte a WAV
                        finalFileExtension = '.wav';
                        console.warn(`[processAudioLoop] MIME type problematic ("${determinedMimeType}"). Fallback aggressivo a: Blob MIME='${finalMimeTypeForBlob}', Estensione='${finalFileExtension}'.`);
                    } else {
                        finalMimeTypeForBlob = determinedMimeType;
                        finalFileExtension = getExtensionFromMimeType(determinedMimeType);
                        if (finalFileExtension === '.bin') { // Se getExtensionFromMimeType fallisce e dà .bin
                            finalFileExtension = '.mp3'; // Prova con .mp3 come ultima spiaggia per l'estensione
                            console.warn(`[processAudioLoop] getExtensionFromMimeType ha dato '.bin' per "${determinedMimeType}". Fallback estensione a '${finalFileExtension}', Blob MIME resta '${finalMimeTypeForBlob}'.`);
                        }
                    }
                    
                    const filenameForApi = `${baseRecordingFilename}${finalFileExtension}`;
                    console.log(`[processAudioLoop] Preparazione invio. Blob MIME: "${finalMimeTypeForBlob}", Estensione: "${finalFileExtension}", Filename API: "${filenameForApi}"`);
                    
                    const audioBlob = new Blob(chunksToSend, { type: finalMimeTypeForBlob });
                    // --- FINE LOGICA MIGLIORATA ---
                    
                    console.log(`[processAudioLoop] Blob creato. Size: ${audioBlob.size}, Type: ${audioBlob.type}`);
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
    console.log(`[sendAudioForTranscription] Tentativo invio. Filename='${filename}', Blob Type='${audioBlob.type}', Blob Size=${audioBlob.size}`);
    if (audioBlob.size === 0) { console.warn("[sendAudioForTranscription] Blob vuoto, non invio."); statusMessage.textContent = 'Audio non rilevato. Riascolto.'; setTimeout(resumeListeningAfterFernanda, 1000); return; }
    if (isTransitioningAudio) { console.warn("[sendAudioForTranscription] isTransitioningAudio=true. Annullamento fetch."); resumeListeningAfterFernanda(); return; }
    
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo audio...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);
    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const responseBodyText = await transcribeResponse.text();
        if (!transcribeResponse.ok) {
            let errorPayload;
            try { errorPayload = JSON.parse(responseBodyText); }
            catch (e) { errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}. Server: ${responseBodyText.substring(0,500)}` }; }
            console.error("[sendAudioForTranscription] Errore Trascrizione (Server):", transcribeResponse.status, errorPayload);
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = JSON.parse(responseBodyText);
        console.log("[sendAudioForTranscription] Whisper transcript:", transcript);
        if (!transcript || transcript.trim().length < 2) { statusMessage.textContent = 'Non ho colto bene. Ripeti?'; setTimeout(resumeListeningAfterFernanda, 1500); return; }
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);
    } catch (error) {
        const rawErrorMessage = error && error.message ? error.message : "Errore sconosciuto trascrizione";
        console.error('[sendAudioForTranscription] Errore completo:', rawErrorMessage, error);
        let displayErrorMessage = `Errore formato audio: ${rawErrorMessage}`; // Default per errore formato
        if (! (rawErrorMessage.toLowerCase().includes("invalid file format") || 
               rawErrorMessage.toLowerCase().includes("format is not supported") || 
               rawErrorMessage.toLowerCase().includes("could not be decoded") ||
               rawErrorMessage.includes("[OpenAI Code:"))) {
            displayErrorMessage = `Errore trascrizione: ${rawErrorMessage}`; // Messaggio più generico se non specifico del formato
        }
        statusMessage.textContent = `${displayErrorMessage}. Riprova.`;
        setTimeout(resumeListeningAfterFernanda, 2500);
    }
}

async function processChatWithFernanda(transcript) {
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda pensa...');
    try {
        const chatResponse = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: transcript, history: conversationHistory }) });
        if (!chatResponse.ok) { const errData = await chatResponse.json().catch(() => ({ error: `Errore API Chat (${chatResponse.status} ${chatResponse.statusText})` })); throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`); }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply:", assistantReply);
        if (!assistantReply || assistantReply.trim() === "") { console.warn("Risposta Fernanda vuota."); statusMessage.textContent = "Fernanda non ha risposto. Riprova."; setTimeout(resumeListeningAfterFernanda, 1500); return; }
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        const MAX_HISTORY_TURNS = 10; if (conversationHistory.length > MAX_HISTORY_TURNS * 2) conversationHistory = conversationHistory.slice(-(MAX_HISTORY_TURNS * 2));
        
        updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda prepara audio...');
        const ttsResponse = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: assistantReply }) });
        if (!ttsResponse.ok) { const errData = await ttsResponse.json().catch(() => ({ error: `Errore API TTS (${ttsResponse.status} ${ttsResponse.statusText})` })); throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);}
        const audioFernandaBlob = await ttsResponse.blob();
        if (audioFernandaBlob.size === 0) { console.error("TTS Blob vuoto."); throw new Error("Audio da Fernanda vuoto (errore TTS)."); }
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        playFernandaAudio(audioUrl);
    } catch (error) {
        console.error('Errore chat/tts:', error.message, error);
        statusMessage.textContent = `Oops, ${error.message}. Riprova.`;
        setTimeout(resumeListeningAfterFernanda, 2000);
    }
}

function playFernandaAudio(audioUrl) {
    if (currentAudio) { currentAudio.pause(); currentAudio.onended = null; currentAudio.onerror = null; if (currentAudio.src && currentAudio.src.startsWith('blob:')) { URL.revokeObjectURL(currentAudio.src); console.log("Revoked old audio URL:", currentAudio.src); } }
    currentAudio = new Audio(audioUrl); isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');
    console.log("Attempting play Fernanda's audio:", audioUrl);
    currentAudio.onended = () => {
        console.log("Fernanda finished. URL:", currentAudio.src); isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) { URL.revokeObjectURL(currentAudio.src); console.log("Revoked URL onended:", currentAudio.src); }
        currentAudio = null; if (currentConversationState === 'fernanda_speaking_continuous') resumeListeningAfterFernanda();
    };
    currentAudio.onerror = (e) => {
        console.error("Errore riproduzione audio Fernanda:", e, currentAudio ? currentAudio.error : 'no currentAudio.error');
        let errMsg = 'Problema audio con Fernanda.';
        if (currentAudio && currentAudio.error) { console.error("MediaError:", `Code: ${currentAudio.error.code}, Msg: ${currentAudio.error.message}`); /* ... (switch case per errori specifici) ... */ }
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) { URL.revokeObjectURL(currentAudio.src); console.log("Revoked URL onerror:", currentAudio.src); }
        currentAudio = null; if (currentConversationState === 'fernanda_speaking_continuous') { statusMessage.textContent = `${errMsg} Riprova.`; setTimeout(resumeListeningAfterFernanda, 1500); }
    };
    currentAudio.play().then(() => { console.log("Audio Fernanda in riproduzione."); })
    .catch(error => {
        console.error("Errore currentAudio.play():", error.name, error.message, error); isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) { URL.revokeObjectURL(currentAudio.src); console.log("Revoked URL on play().catch:", currentAudio.src); }
        currentAudio = null; if (currentConversationState === 'fernanda_speaking_continuous') { let userMsg = `Errore play audio: ${error.name}. Riprova.`; statusMessage.textContent = userMsg; setTimeout(resumeListeningAfterFernanda, 1500); }
    });
}

function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda. Stato:", currentConversationState, "Stream:", !!globalStream);
    if (currentConversationState !== 'idle' && globalStream) {
        isTransitioningAudio = true; console.log("isTransitioningAudio = true per riprendere ascolto.");
        currentTurnAudioChunks = [];
        setTimeout(() => { // Breve timeout per permettere la chiusura di risorse/transizioni
            if (!globalStream || !audioContext || !analyser || !microphoneSource) { console.error("Dipendenze mancanti per startVAD in resumeListening."); isTransitioningAudio = false; cleanUpFullSession(); return; }
            if (audioContext.state === 'suspended') {
                console.warn("AudioContext sospeso prima di startVAD in resume. Ripresa...");
                audioContext.resume().then(() => { console.log("AudioContext ripreso in resumeListening."); startVAD(); })
                .catch(err => { console.error("Fallimento ripresa AudioContext in resumeListening.", err); isTransitioningAudio = false; cleanUpFullSession(); });
            } else { startVAD(); }
        }, 150);
    } else {
        console.log("resumeListeningAfterFernanda: sessione non attiva/valida o terminata.");
        if (!globalStream && currentConversationState !== 'idle') { console.warn("GlobalStream perso, stato non idle. Pulizia."); cleanUpFullSession(); }
    }
}

async function handleControlButtonClick() {
    console.log("handleControlButtonClick. Stato:", currentConversationState, "isTransitioningAudio:", isTransitioningAudio);

    if (currentConversationState === 'idle' && !window.audioPlaybackUnlockedViaInteraction) {
        console.log("Attempting non-blocking audio unlock for mobile...");
        let unlockAudio = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
        unlockAudio.volume = 0.001;
        unlockAudio.play().then(() => { window.audioPlaybackUnlockedViaInteraction = true; console.log("Silent audio played for unlock."); })
        .catch(err => console.warn("Silent audio unlock failed:", err.name))
        .finally(() => { unlockAudio = null; });
    }
    
    if (audioContext && audioContext.state === 'suspended') {
        console.log("AudioContext sospeso. Tentativo resume per interazione utente...");
        await audioContext.resume().catch(e => console.warn("Resume AudioContext on click fallito:", e));
        console.log("AudioContext state after resume attempt:", audioContext.state);
    }

    if (isTransitioningAudio) { console.log("Click ignorato, isTransitioningAudio = true"); statusMessage.textContent = "Attendere prego..."; return; }

    if (currentConversationState === 'idle') {
        isTransitioningAudio = true; updateUI('idle', 'Avvio...', 'icon-mic', 'Inizializzazione audio...');
        const ready = await initializeAudioProcessing();
        if (ready) { startVAD(); } 
        else { isTransitioningAudio = false; /* UI già aggiornata da initializeAudioProcessing in caso di errore */ }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        console.log("User requested stop session."); isTransitioningAudio = true;
        const currentIcon = controlButton.querySelector('span') ? controlButton.querySelector('span').className : 'icon-stop';
        updateUI(currentConversationState, 'Stop...', currentIcon, 'Terminazione sessione...');
        cleanUpFullSession();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        console.log("User requested interrupt Fernanda."); isTransitioningAudio = true;
        updateUI('fernanda_speaking_continuous', 'Stop...', 'icon-stop', 'Interrompo Fernanda...');
        if (currentAudio) { currentAudio.pause(); if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src); currentAudio = null; }
        isFernandaSpeaking = false;
        resumeListeningAfterFernanda();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM caricato. User Agent:", navigator.userAgent);
    const mediaRecorderSupported = typeof MediaRecorder !== 'undefined';
    const getUserMediaSupported = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

    if (!getUserMediaSupported) { console.error("getUserMedia non supportato."); updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.'); controlButton.disabled = true; }
    else if (!mediaRecorderSupported) { console.error("MediaRecorder API non supportata."); updateUI('idle', 'Non Supportato', 'icon-mic', 'Registrazione non supportata.'); controlButton.disabled = true; }
    else { updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.'); }
    controlButton.addEventListener('click', handleControlButtonClick);
});
