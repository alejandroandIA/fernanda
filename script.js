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
        return '.bin'; // Fallback generico
    }
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    let extension;
    switch (typeSpecific) {
        case 'audio/mp4': 
            extension = '.m4a'; // OpenAI supporta .m4a per audio AAC in container MP4
            console.log("[getExtensionFromMimeType] audio/mp4 rilevato, usando estensione .m4a");
            break;
        case 'audio/m4a': 
            extension = '.m4a'; 
            break;
        case 'audio/wav': case 'audio/wave': 
            extension = '.wav'; 
            break;
        case 'audio/webm': 
            extension = '.webm'; 
            break;
        case 'audio/ogg': 
            extension = '.ogg'; 
            break;
        case 'audio/mpeg': 
            extension = '.mp3'; 
            break;
        case 'audio/opus': // Se il MIME è specificamente audio/opus (non dentro webm/ogg)
            extension = '.opus'; 
            break;
        case 'audio/aac': // AAC puro è meno comune da MediaRecorder, OpenAI preferisce m4a/mp4 per AAC
            extension = '.aac'; // Potrebbe essere problematico per OpenAI, .m4a è più sicuro
            console.log("[getExtensionFromMimeType] audio/aac rilevato, usando .aac (preferire .m4a se possibile)");
            break;
        default:
            console.warn(`[getExtensionFromMimeType] Nessuna estensione nota per MIME: ${typeSpecific}. Tentativo fallback esteso.`);
            if (mimeType.includes('opus') && !typeSpecific.includes('webm') && !typeSpecific.includes('ogg')) {
                 extension = '.opus'; // Opus puro
            } else {
                extension = '.bin'; // Fallback finale se nessun match
                console.log(`[getExtensionFromMimeType] Fallback finale a: ${extension}`);
            }
    }
    console.log("[getExtensionFromMimeType] Output estensione:", extension);
    return extension;
}


async function initializeAudioProcessing() {
    console.log("Initializing audio processing...");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true; return false;
    }
    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Microphone access granted.");

        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext created. Initial state:", audioContext.state);
        if (audioContext.state === 'suspended') {
            console.log("AudioContext is suspended, attempting to resume...");
            await audioContext.resume().catch(err => console.error("Failed to resume AudioContext:", err));
            console.log("AudioContext state after resume attempt:", audioContext.state);
        }

        analyser = audioContext.createAnalyser(); /* ... (config analyser) ... */
        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);
        console.log("Audio pipeline setup complete.");

        let preferredMimeType = '';
        // Priorità per iOS/Safari, poi fallback sicuri e formati comuni
        const mimeTypesToTest = [
            'audio/mp4',                // Per AAC su iOS (Safari), OpenAI supporta .mp4/.m4a
            'audio/wav',                // Fallback sicuro, supportato da OpenAI
            'audio/webm;codecs=opus',   // Buona qualità/compressione, supportato
            'audio/aac',                // Meno comune da MediaRecorder, ma teoricamente AAC
            'audio/mpeg',               // Per MP3, supportato
            'audio/ogg;codecs=opus',    // Altro formato compresso comune
        ];
        console.log("[initializeAudioProcessing] Testing MIME types:", mimeTypesToTest);
        for (const mime of mimeTypesToTest) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                console.log(`[initializeAudioProcessing] Supported MIME type found: ${preferredMimeType}`);
                break;
            } else { console.log(`[initializeAudioProcessing] MIME type NOT supported: ${mime}`); }
        }
        
        if (!preferredMimeType && MediaRecorder.isTypeSupported('')) {
            console.warn("[initializeAudioProcessing] No explicit preferred MIME type supported. Using browser default (recordingMimeType='').");
            recordingMimeType = ''; 
        } else if (!preferredMimeType) {
            console.error("[initializeAudioProcessing] CRITICAL: MediaRecorder supports no common audio formats or default.");
            updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato.');
            controlButton.disabled = true; cleanUpFullSession(); return false;
        } else {
            recordingMimeType = preferredMimeType;
        }
        console.log("[initializeAudioProcessing] Initial recordingMimeType:", recordingMimeType || "Browser Default");
        return true;

    } catch (err) { /* ... (gestione errori getUserMedia) ... */ 
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

function stopAndReleaseMediaRecorder() { /* ... (codice invariato) ... */ 
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

function startVAD() { /* ... (codice in gran parte invariato, assicurarsi che recordingMimeType venga aggiornato con mediaRecorderForVAD.mimeType) ... */
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

function cleanUpFullSession() { /* ... (codice invariato) ... */ 
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
    // ... (VAD logic: dataArray, rms, currentTime - codice invariato) ...
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += ((dataArray[i] / 128.0) - 1.0) ** 2;
    const rms = Math.sqrt(sum / dataArray.length);
    const currentTime = performance.now();


    if (rms > VAD_SILENCE_THRESHOLD) { /* ... (speaking logic) ... */ 
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

                    // --- NUOVA LOGICA PER DETERMINARE FORMATO AUDIO PER OPENAI ---
                    let actualMimeType = mediaRecorderForVAD?.mimeType || recordingMimeType;
                    let finalMimeTypeForBlob;
                    let finalFileExtension;

                    console.log(`[processAudioLoop] Determining format. ActualMimeType from MediaRecorder/Global: "${actualMimeType}"`);

                    // Logica specifica basata sul contenuto del MIME type
                    if (actualMimeType && (actualMimeType.includes('mp4') || actualMimeType.includes('aac'))) {
                        finalMimeTypeForBlob = 'audio/mp4'; // Tipo di Blob consistente per AAC in MP4
                        finalFileExtension = '.m4a';        // Estensione preferita da OpenAI per audio AAC
                        console.log(`[processAudioLoop] Detected MP4/AAC-related MIME. Using Blob MIME: ${finalMimeTypeForBlob}, Extension: ${finalFileExtension}`);
                    } else if (actualMimeType && actualMimeType.includes('webm')) {
                        finalMimeTypeForBlob = actualMimeType.split(';')[0]; // es. 'audio/webm'
                        finalFileExtension = '.webm';
                        console.log(`[processAudioLoop] Detected WebM-related MIME. Using Blob MIME: ${finalMimeTypeForBlob}, Extension: ${finalFileExtension}`);
                    } else if (actualMimeType && actualMimeType.includes('wav')) {
                        finalMimeTypeForBlob = 'audio/wav';
                        finalFileExtension = '.wav';
                        console.log(`[processAudioLoop] Detected WAV-related MIME. Using Blob MIME: ${finalMimeTypeForBlob}, Extension: ${finalFileExtension}`);
                    } else if (actualMimeType && actualMimeType.includes('ogg')) {
                        finalMimeTypeForBlob = actualMimeType.split(';')[0]; // es. 'audio/ogg'
                        finalFileExtension = '.ogg';
                        console.log(`[processAudioLoop] Detected OGG-related MIME. Using Blob MIME: ${finalMimeTypeForBlob}, Extension: ${finalFileExtension}`);
                    } else if (actualMimeType && actualMimeType.includes('mpeg')) { // Per MP3
                        finalMimeTypeForBlob = 'audio/mpeg';
                        finalFileExtension = '.mp3';
                        console.log(`[processAudioLoop] Detected MPEG-related MIME (MP3). Using Blob MIME: ${finalMimeTypeForBlob}, Extension: ${finalFileExtension}`);
                    } else if (actualMimeType && actualMimeType.includes('opus')) { // Opus puro
                         finalMimeTypeForBlob = 'audio/opus';
                         finalFileExtension = '.opus';
                         console.log(`[processAudioLoop] Detected Opus-related MIME. Using Blob MIME: ${finalMimeTypeForBlob}, Extension: ${finalFileExtension}`);
                    }
                    else {
                        // Fallback aggressivo per MIME sconosciuti, vuoti, o generici (es. application/octet-stream)
                        // Particolarmente mirato a iOS/Safari che potrebbe registrare AAC in MP4 senza un MIME type chiaro.
                        console.warn(`[processAudioLoop] Undetermined or generic MIME: "${actualMimeType}". Applying aggressive fallback (MP4/M4A) assuming mobile AAC.`);
                        finalMimeTypeForBlob = 'audio/mp4'; // Tipo MIME che iOS Safari "capisce" per il contenuto AAC
                        finalFileExtension = '.m4a';        // Estensione che OpenAI capisce per audio AAC
                    }
                    
                    const filenameForApi = `${baseRecordingFilename}${finalFileExtension}`;
                    console.log(`[processAudioLoop] Preparazione invio. Blob MIME: "${finalMimeTypeForBlob}", Estensione: "${finalFileExtension}", Filename API: "${filenameForApi}"`);
                    
                    const audioBlob = new Blob(chunksToSend, { type: finalMimeTypeForBlob });
                    // --- FINE NUOVA LOGICA ---
                    
                    console.log(`[processAudioLoop] Blob creato. Size: ${audioBlob.size}, Type: ${audioBlob.type}`);
                    sendAudioForTranscription(audioBlob, filenameForApi);
                    return;

                } else { /* ... (parlato breve o no chunk) ... */ 
                    console.log(`VAD: Parlato breve (${speechDuration.toFixed(0)}ms) o no chunk (${currentTurnAudioChunks.length}).`);
                    currentTurnAudioChunks = [];
                }
            }
        } else { /* ... (non sta parlando, aggiorna silenceStartTime) ... */ 
            silenceStartTime = currentTime;
        }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) { /* ... (codice invariato, ma i log da qui saranno più informativi) ... */ 
    console.log(`[sendAudioForTranscription] Tentativo invio. Filename='${filename}', Blob Type='${audioBlob.type}', Blob Size=${audioBlob.size}`);
    if (audioBlob.size === 0) {
        console.warn("[sendAudioForTranscription] Blob audio vuoto, non invio. Riprendo ascolto.");
        statusMessage.textContent = 'Audio non rilevato. Riascolto.';
        setTimeout(resumeListeningAfterFernanda, 1000);
        return;
    }
    if (isTransitioningAudio) {
        console.warn("[sendAudioForTranscription] isTransitioningAudio=true. Annullamento fetch. Riprendo ascolto.");
        resumeListeningAfterFernanda();
        return;
    }
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo audio...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename); // Il filename con estensione è cruciale per OpenAI
    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const responseBodyText = await transcribeResponse.text();
        if (!transcribeResponse.ok) {
            let errorPayload;
            try { errorPayload = JSON.parse(responseBodyText); }
            catch (e) { errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}. Risposta Server: ${responseBodyText.substring(0,500)}` }; } // Mostra parte della risposta
            console.error("[sendAudioForTranscription] Errore Trascrizione (Server):", transcribeResponse.status, errorPayload);
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = JSON.parse(responseBodyText);
        console.log("[sendAudioForTranscription] Whisper transcript (VAD):", transcript);
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
        console.error('[sendAudioForTranscription] Errore completo (VAD):', rawErrorMessage, error);
        // Rendi il messaggio più specifico se l'errore viene da OpenAI e riguarda il formato
        if (rawErrorMessage.toLowerCase().includes("invalid file format") || 
            rawErrorMessage.toLowerCase().includes("format is not supported") || 
            rawErrorMessage.toLowerCase().includes("could not be decoded") ||
            rawErrorMessage.includes("[OpenAI Code:")) { // Aggiunto per coprire errori strutturati da OpenAI
            displayErrorMessage = `Errore formato audio: ${rawErrorMessage}`; 
        } else {
            displayErrorMessage = `Errore trascrizione: ${rawErrorMessage}`;
        }
        statusMessage.textContent = `${displayErrorMessage}. Riprova.`;
        setTimeout(resumeListeningAfterFernanda, 2500); // Aumentato leggermente il timeout per dare tempo di leggere
    }
}

async function processChatWithFernanda(transcript) { /* ... (codice invariato) ... */ 
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
        setTimeout(resumeListeningAfterFernanda, 2000);
    }
}

function playFernandaAudio(audioUrl) { /* ... (codice invariato) ... */ 
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
        console.error("Errore riproduzione audio Fernanda (VAD):", e, currentAudio && currentAudio.error ? `Code: ${currentAudio.error.code}, Msg: ${currentAudio.error.message}`: "No MediaError details");
        let errorMessageForUser = 'Problema audio con Fernanda.';
        // (Error handling switch case for MediaError could be re-added if needed)
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
            // (Other specific error.name checks)
            else userMessage = `Errore play audio: ${error.name}. Riprova.`;
            statusMessage.textContent = userMessage;
            setTimeout(resumeListeningAfterFernanda, 1500);
        }
    });
}

function resumeListeningAfterFernanda() { /* ... (codice invariato) ... */ 
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
        }, 150); // Leggermente aumentato per dare tempo
    } else {
        console.log("resumeListeningAfterFernanda: sessione non attiva/valida o terminata.");
        if (!globalStream && currentConversationState !== 'idle') {
            console.warn("resumeListeningAfterFernanda: globalStream perso, stato non idle. Pulizia.");
            cleanUpFullSession();
        }
    }
}

async function handleControlButtonClick() { /* ... (codice invariato) ... */ 
    console.log("handleControlButtonClick. Stato:", currentConversationState, "isTransitioningAudio:", isTransitioningAudio);

    if (currentConversationState === 'idle' && !window.audioPlaybackUnlockedViaInteraction) {
        console.log("Attempting non-blocking audio unlock for mobile...");
        let unlockAudioPlayer = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
        unlockAudioPlayer.volume = 0.001;
        unlockAudioPlayer.play()
            .then(() => {
                console.log("Silent audio play() initiated for unlocking.");
                window.audioPlaybackUnlockedViaInteraction = true;
            })
            .catch((err) => console.warn("Silent audio play() for unlocking failed:", err.name))
            .finally(() => { unlockAudioPlayer = null; });
    }
    
    if (audioContext && audioContext.state === 'suspended') {
        console.log("AudioContext (VAD) sospeso. Tentativo resume per interazione...");
        try {
            await audioContext.resume();
            console.log("AudioContext (VAD) resumed by user interaction. State:", audioContext.state);
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
            startVAD();
        } else {
            isTransitioningAudio = false;
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        console.log("User requested stop session.");
        isTransitioningAudio = true;
        const currentIconClass = controlButton.querySelector('span') ? controlButton.querySelector('span').className : 'icon-stop';
        updateUI(currentConversationState, 'Stop...', currentIconClass, 'Terminazione sessione...');
        cleanUpFullSession();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        console.log("User requested interrupt Fernanda.");
        isTransitioningAudio = true;
        updateUI('fernanda_speaking_continuous', 'Stop...', 'icon-stop', 'Interrompo Fernanda...');
        if (currentAudio) {
            currentAudio.pause();
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        resumeListeningAfterFernanda();
    }
}

document.addEventListener('DOMContentLoaded', () => { /* ... (codice invariato) ... */ 
    console.log("DOM caricato. User Agent:", navigator.userAgent);
    let mediaRecorderSupported = typeof MediaRecorder !== 'undefined';
    let getUserMediaSupported = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

    if (!getUserMediaSupported) {
        console.error("getUserMedia non supportato.");
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
    } else if (!mediaRecorderSupported) {
        console.error("MediaRecorder API non supportata.");
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Registrazione audio non supportata.');
        controlButton.disabled = true;
    } else {
        updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    }
    controlButton.addEventListener('click', handleControlButtonClick);
});
