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
        case 'audio/mpeg': extension = '.mp3'; break;
        case 'audio/wav': case 'audio/wave': extension = '.wav'; break;
        case 'audio/webm': extension = '.webm'; break;
        case 'audio/opus': extension = '.opus'; break;
        case 'audio/mp4':
            extension = '.m4a'; // OpenAI supporta m4a, e audio/mp4 è spesso AAC in MP4
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
            extension = '.bin'; // Fallback per sconosciuti, Whisper potrebbe non supportarlo
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
        // **MODIFICA CHIAVE QUI: Cambia priorità dei MIME type**
        const mimeTypesToTest = [
            'audio/wav',                // Prova WAV per primo - più robusto per Whisper
            'audio/mp4',                // Poi MP4 (spesso AAC in MP4 su mobile, che diventa .m4a)
            'audio/webm;codecs=opus',   // WebM con Opus è una buona opzione se supportata
            'audio/mpeg',               // MP3 è meno probabile che sia supportato per la registrazione da MediaRecorder
            'audio/aac',                // AAC diretto (potrebbe essere incapsulato in .m4a o .aac)
            'audio/ogg;codecs=opus',
        ];
        console.log("[initializeAudioProcessing] Testando MIME types (nuova priorità):", mimeTypesToTest);

        for (const mime of mimeTypesToTest) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                console.log(`[initializeAudioProcessing] MIME type supportato trovato: ${preferredMimeType}`);
                break;
            } else {
                console.log(`[initializeAudioProcessing] MIME type NON supportato: ${mime}`);
            }
        }

        if (!preferredMimeType) {
            if (MediaRecorder.isTypeSupported('')) { // Tenta con il default del browser se nessun preferito è supportato
                console.warn("[initializeAudioProcessing] Nessun MIME type preferito supportato. Usando default browser (vuoto).");
                recordingMimeType = ''; // Lascia vuoto per usare il default del browser
            } else {
                console.error("[initializeAudioProcessing] CRITICAL: MediaRecorder non supporta formati audio comuni né il default.");
                updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato.');
                controlButton.disabled = true;
                cleanUpFullSession();
                return false;
            }
        } else {
            recordingMimeType = preferredMimeType;
        }

        console.log("[initializeAudioProcessing] VAD Init: Effective MIME Type to request (iniziale):", recordingMimeType || "Browser Default");
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
    console.log("[startVAD] Attempting MediaRecorder creation. Options:", options);
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("[startVAD] New MediaRecorder. Requested MIME:", options.mimeType || "Default", "Actual MediaRecorder.mimeType:", mediaRecorderForVAD.mimeType);

        // Aggiorna recordingMimeType globale con quello effettivo se MediaRecorder lo fornisce e differisce
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.warn(`[startVAD] MediaRecorder is using "${mediaRecorderForVAD.mimeType}", which differs from requested/global "${recordingMimeType}". Updating global recordingMimeType.`);
            recordingMimeType = mediaRecorderForVAD.mimeType; // Questo è importante!
        } else if (!mediaRecorderForVAD.mimeType && recordingMimeType) {
            console.warn(`[startVAD] MediaRecorder did not report an effective MIME type. Sticking with globally set/requested: "${recordingMimeType}".`);
        } else if (!mediaRecorderForVAD.mimeType && !recordingMimeType) {
            console.error("[startVAD] CRITICAL: MediaRecorder does not have an effective MIME type and no default was specified. Recording might fail or produce unusable data for Whisper.");
            // Non impostare recordingMimeType a qualcosa di arbitrario qui, potrebbe essere peggio.
            // La logica in processAudioLoop tenterà di gestire 'application/octet-stream'
        }
        console.log("[startVAD] Effective global recordingMimeType for this session (after MediaRecorder creation):", recordingMimeType);

    } catch (e) {
        console.error("Error creating MediaRecorder:", e.name, e.message, e, "Options:", options);
        isTransitioningAudio = false;
        cleanUpFullSession();
        let errorMsg = 'Errore MediaRecorder.';
        if (e.name === 'SecurityError') errorMsg = 'Errore sicurezza MediaRecorder.';
        if (e.name === 'NotSupportedError' || e.message.toLowerCase().includes('mime type')) errorMsg = `Formato audio (${recordingMimeType || 'default'}) non supportato dal registratore.`;
        updateUI('idle', 'Errore Registratore', 'icon-mic', errorMsg);
        return;
    }
    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) currentTurnAudioChunks.push(event.data);
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("[MediaRecorder.onstart] Triggered. Effective MediaRecorder.mimeType:", mediaRecorderForVAD.mimeType);
        // Riafferma l'aggiornamento del recordingMimeType globale se necessario
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.log(`[MediaRecorder.onstart] Updating global recordingMimeType from "${recordingMimeType}" to "${mediaRecorderForVAD.mimeType}"`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
        isTransitioningAudio = false;
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("[MediaRecorder.onstop] Triggered. Chunks collected:", currentTurnAudioChunks.length, "Total size (approx):", currentTurnAudioChunks.reduce((s, b) => s + b.size, 0), "bytes");
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error ? event.error.name : "Unknown", event.error ? event.error.message : "No message", event.error);
        isTransitioningAudio = false;
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema registrazione. Riprova.');
        stopAndReleaseMediaRecorder(); // Non chiamare cleanUpFullSession qui, potrebbe essere troppo drastico
    };
    try {
        mediaRecorderForVAD.start(500); // Raccogli dati ogni 500ms
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
        if (currentConversationState === 'listening_continuous' && !isTransitioningAudio) { // Aggiunto !isTransitioningAudio per evitare loop se si sta chiudendo
             vadProcessTimeout = requestAnimationFrame(processAudioLoop);
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
        silenceStartTime = currentTime; // Resetta il timer del silenzio se c'è voce
    } else { // Silenzio (RMS sotto soglia)
        if (speaking) { // Se stava parlando e ora c'è silenzio
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                speaking = false; // Ha smesso di parlare
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS; // Durata effettiva del parlato
                console.log(`VAD: End speech detected. Duration: ${speechDuration.toFixed(0)}ms.`);

                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = []; // Resetta subito per non inviare due volte

                    if (isTransitioningAudio) { // Doppio controllo
                        console.warn("ProcessAudioLoop: isTransitioningAudio=true. Annullamento invio.");
                        vadProcessTimeout = requestAnimationFrame(processAudioLoop); // Continua il loop se serve
                        return;
                    }
                    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo audio...'); // Aggiorna UI prima dell'invio

                    // **LOGICA MIME TYPE E FILENAME RAFFORZATA**
                    let effectiveRecorderMimeType = mediaRecorderForVAD?.mimeType || '';
                    let negotiatedRecordingMimeType = recordingMimeType || ''; // Quello da initializeAudioProcessing

                    // Determina il MIME type base da usare per l'estensione e il Blob
                    let baseMimeTypeForBlobCreation = negotiatedRecordingMimeType; // Inizia con quello negoziato
                    if (effectiveRecorderMimeType && effectiveRecorderMimeType !== 'application/octet-stream' && effectiveRecorderMimeType !== '') {
                        // Se MediaRecorder riporta un tipo specifico, usalo, potrebbe essere più accurato
                        baseMimeTypeForBlobCreation = effectiveRecorderMimeType;
                    } else if (!negotiatedRecordingMimeType && !effectiveRecorderMimeType) {
                        // Fallback se entrambi sono vuoti (caso raro)
                        console.warn("[processAudioLoop] Sia negotiated che effective MIME type sono vuoti. Tentativo con 'application/octet-stream'.");
                        baseMimeTypeForBlobCreation = 'application/octet-stream';
                    }
                    // Se baseMimeTypeForBlobCreation è ancora vuoto, significa che recordingMimeType (globale) era vuoto (default browser)
                    // e mediaRecorder.mimeType era vuoto o non specifico.
                    if (!baseMimeTypeForBlobCreation) {
                        console.warn("[processAudioLoop] MIME type base per blob creation è ancora vuoto. Usando 'application/octet-stream' come ultimo fallback.");
                        baseMimeTypeForBlobCreation = 'application/octet-stream';
                    }

                    const determinedFileExtension = getExtensionFromMimeType(baseMimeTypeForBlobCreation);
                    let finalMimeTypeForBlob = baseMimeTypeForBlobCreation; // Default

                    // Logica di allineamento per coerenza tra estensione e tipo Blob
                    const mainMimePart = baseMimeTypeForBlobCreation.split(';')[0].toLowerCase();

                    if (determinedFileExtension === '.m4a' && !['audio/mp4', 'audio/m4a'].includes(mainMimePart)) {
                        console.log(`[processAudioLoop] Estensione .m4a, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/mp4' (o 'audio/m4a').`);
                        finalMimeTypeForBlob = 'audio/mp4'; // 'audio/m4a' potrebbe essere più preciso, ma 'audio/mp4' è spesso il contenitore
                    } else if (determinedFileExtension === '.mp4' && mainMimePart !== 'audio/mp4') {
                         console.log(`[processAudioLoop] Estensione .mp4, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/mp4'.`);
                        finalMimeTypeForBlob = 'audio/mp4';
                    } else if (determinedFileExtension === '.mp3' && mainMimePart !== 'audio/mpeg') {
                        console.log(`[processAudioLoop] Estensione .mp3, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/mpeg'.`);
                        finalMimeTypeForBlob = 'audio/mpeg';
                    } else if (determinedFileExtension === '.wav' && mainMimePart !== 'audio/wav') {
                        console.log(`[processAudioLoop] Estensione .wav, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/wav'.`);
                        finalMimeTypeForBlob = 'audio/wav';
                    } else if (determinedFileExtension === '.aac' && mainMimePart !== 'audio/aac') {
                        console.log(`[processAudioLoop] Estensione .aac, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/aac'.`);
                        finalMimeTypeForBlob = 'audio/aac';
                    } else if (determinedFileExtension === '.webm' && mainMimePart !== 'audio/webm') {
                        console.log(`[processAudioLoop] Estensione .webm, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/webm'.`);
                        finalMimeTypeForBlob = 'audio/webm';
                    } else if (determinedFileExtension === '.ogg' && mainMimePart !== 'audio/ogg') {
                        console.log(`[processAudioLoop] Estensione .ogg, ma MIME base ${baseMimeTypeForBlobCreation}. Allineo tipo Blob a 'audio/ogg'.`);
                        finalMimeTypeForBlob = 'audio/ogg';
                    }

                    // Se l'estensione è .bin (fallback di getExtensionFromMimeType), inviamo con un filename .bin
                    // e speriamo che OpenAI possa gestirlo, oppure che il `finalMimeTypeForBlob` sia abbastanza buono.
                    // Se finalMimeTypeForBlob è 'application/octet-stream' e l'estensione .bin, è il caso peggiore.
                    if (determinedFileExtension === '.bin' && finalMimeTypeForBlob === 'application/octet-stream') {
                        console.warn("[processAudioLoop] Rilevata estensione .bin e MIME type application/octet-stream. Whisper potrebbe fallire.");
                    }


                    const filenameForApi = `${baseRecordingFilename}${determinedFileExtension}`;

                    console.log(`[processAudioLoop] DETTAGLI PRE-BLOB:
                      Initial global recordingMimeType (negotiated): "${negotiatedRecordingMimeType}"
                      MediaRecorder effettivo mimeType: "${effectiveRecorderMimeType}"
                      MIME type base scelto per derivare estensione (baseMimeTypeForBlobCreation): "${baseMimeTypeForBlobCreation}"
                      Estensione calcolata: "${determinedFileExtension}"
                      MIME type finale per Blob (finalMimeTypeForBlob): "${finalMimeTypeForBlob}"
                      Filename per API: "${filenameForApi}"`);

                    const audioBlob = new Blob(chunksToSend, { type: finalMimeTypeForBlob });

                    console.log(`[processAudioLoop] DETTAGLI POST-BLOB:
                      Blob creato. Size: ${audioBlob.size}, Effective Blob Type: ${audioBlob.type}`);

                    if (audioBlob.size === 0) {
                        console.warn("[processAudioLoop] Blob audio vuoto dopo la creazione, non invio. Riprendo ascolto.");
                        statusMessage.textContent = 'Audio non rilevato (vuoto). Riascolto.';
                        setTimeout(() => {
                            if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
                        }, 1000);
                        return; // Esce da processAudioLoop
                    }

                    sendAudioForTranscription(audioBlob, filenameForApi);
                    return; // Esce da processAudioLoop dopo aver avviato l'invio
                } else {
                    console.log(`VAD: Parlato troppo breve (${speechDuration.toFixed(0)}ms) o nessun chunk audio (${currentTurnAudioChunks.length}). Ripulendo chunks e riprendendo ascolto.`);
                    currentTurnAudioChunks = []; // Assicurati che i chunk vengano resettati
                    // Non c'è bisogno di chiamare resumeListeningAfterFernanda qui, il loop continua da solo se lo stato è corretto
                }
            }
        } else { // Non sta parlando (era già in silenzio)
            silenceStartTime = currentTime; // Continua ad aggiornare l'inizio del silenzio
        }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) {
    console.log(`[sendAudioForTranscription] Tentativo invio. Filename='${filename}', Blob Type='${audioBlob.type}', Blob Size=${audioBlob.size}`);
    if (audioBlob.size === 0) { // Controllo ridondante, ma sicuro
        console.warn("[sendAudioForTranscription] Blob audio vuoto, non invio. Riprendo ascolto.");
        statusMessage.textContent = 'Audio non rilevato. Riascolto.';
        setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 1000);
        return;
    }
    if (isTransitioningAudio) {
        console.warn("[sendAudioForTranscription] isTransitioningAudio=true. Annullamento fetch. Riprendo ascolto.");
        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
        return;
    }
    // L'UI dovrebbe essere già 'processing_vad_chunk' da processAudioLoop

    const formData = new FormData();
    formData.append('audio', audioBlob, filename); // Il filename con l'estensione corretta è cruciale
    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const responseBodyText = await transcribeResponse.text(); // Leggi sempre come testo prima
        if (!transcribeResponse.ok) {
            let errorPayload;
            try { errorPayload = JSON.parse(responseBodyText); }
            catch (e) { errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}. Risposta Server: ${responseBodyText}` }; }
            console.error("[sendAudioForTranscription] Errore Trascrizione (Server):", transcribeResponse.status, errorPayload.error || responseBodyText);
            // Usa l'errore più dettagliato dal payload se disponibile
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = JSON.parse(responseBodyText);
        console.log("[sendAudioForTranscription] Whisper transcript (VAD):", transcript);
        if (!transcript || transcript.trim().length < 2) { // Troppo corto per essere utile
            statusMessage.textContent = 'Non ho colto bene. Ripeti?';
            setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 1500);
            return;
        }
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);
    } catch (error) {
        let displayErrorMessage = "Errore trascrizione.";
        const rawErrorMessage = error && error.message ? error.message : "Errore sconosciuto trascrizione";
        console.error('[sendAudioForTranscription] Errore completo (VAD):', rawErrorMessage, error);

        // Migliore visualizzazione dell'errore specifico di formato file
        if (rawErrorMessage.toLowerCase().includes("invalid file format") ||
            rawErrorMessage.toLowerCase().includes("format is not supported") ||
            rawErrorMessage.toLowerCase().includes("could not be decoded") ||
            rawErrorMessage.includes("[OpenAI Code:") || // Errori formattati da api/transcribe.js
            transcribeResponse && transcribeResponse.status === 400) { // Cattura 400 generici qui
            displayErrorMessage = `Errore formato audio inviato: ${rawErrorMessage}. Riprova.`;
        } else {
            displayErrorMessage = `${rawErrorMessage}. Riprova.`;
        }
        statusMessage.textContent = displayErrorMessage;
        setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 3000); // Più tempo per leggere errore
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
            setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 1500);
            return;
        }
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        const MAX_HISTORY_TURNS = 10; // 10 scambi (utente + assistente)
        if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
            conversationHistory = conversationHistory.slice(conversationHistory.length - (MAX_HISTORY_TURNS * 2));
        }
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
        setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 2000);
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
    console.log("Attempting play Fernanda's audio:", audioUrl, "Type:", currentAudio.type); // Aggiunto log tipo audio per debug
    currentAudio.onended = () => {
        console.log("Fernanda finished speaking. URL:", currentAudio.src);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
            console.log("Revoked audio URL onended:", currentAudio.src);
        }
        currentAudio = null;
        // Solo riprendi ascolto se la sessione non è stata interrotta nel frattempo
        if (currentConversationState === 'fernanda_speaking_continuous') {
             resumeListeningAfterFernanda();
        }
    };
    currentAudio.onerror = (e) => {
        console.error("Errore riproduzione audio Fernanda (VAD):", e);
        let errorMessageForUser = 'Problema audio con Fernanda.';
        if (currentAudio && currentAudio.error) {
            console.error("MediaError details:", `Code: ${currentAudio.error.code}, Message: ${currentAudio.error.message}`);
            switch (currentAudio.error.code) {
                case MediaError.MEDIA_ERR_ABORTED: errorMessageForUser = 'Riproduzione audio interrotta.'; break;
                case MediaError.MEDIA_ERR_NETWORK: errorMessageForUser = 'Errore rete riproduzione audio.'; break;
                case MediaError.MEDIA_ERR_DECODE: errorMessageForUser = 'Errore decodifica audio da Fernanda.'; break; // Più specifico
                case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: errorMessageForUser = 'Formato audio da Fernanda non supportato dal browser.'; break; // Più specifico
                default: errorMessageForUser = `Problema audio Fernanda (${currentAudio.error.message || 'dettaglio non disp.'}).`;
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
            setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 1500);
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
            else userMessage = `Errore play audio Fernanda: ${error.name}. Riprova.`;
            statusMessage.textContent = userMessage;
            setTimeout(() => { if (currentConversationState !== 'idle') resumeListeningAfterFernanda(); }, 1500);
        }
    });
}

function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda. Current state:", currentConversationState, "Global stream:", !!globalStream, "isTransitioningAudio:", isTransitioningAudio);
    // Solo procedi se la conversazione è ancora attiva e non si sta già transizionando o è in idle
    if (currentConversationState !== 'idle' && globalStream && !isTransitioningAudio) {
        isTransitioningAudio = true; // Blocca altre azioni mentre si riprende
        console.log("Impostato isTransitioningAudio = true per riprendere ascolto.");
        currentTurnAudioChunks = []; // Pulisci chunk precedenti
        // updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Riascolto...'); // Aggiorna UI
        
        setTimeout(() => { // Un piccolo timeout per permettere a tutto di stabilizzarsi
            if (!globalStream || !audioContext || !analyser || !microphoneSource) {
                console.error("Dipendenze mancanti per startVAD in resumeListening (timeout). Pulizia.");
                isTransitioningAudio = false; // Sblocca
                cleanUpFullSession(); // Se manca qualcosa di critico, meglio pulire
                return;
            }
            if (audioContext.state === 'suspended') {
                console.warn("AudioContext (VAD) sospeso prima di startVAD in resume. Ripresa...");
                audioContext.resume().then(() => {
                    console.log("AudioContext (VAD) ripreso in resumeListening.");
                    startVAD(); // startVAD imposterà isTransitioningAudio a false
                }).catch(err => {
                    console.error("Fallimento ripresa AudioContext (VAD) in resumeListening.", err);
                    isTransitioningAudio = false; // Sblocca
                    cleanUpFullSession(); // Se non si riesce a riprendere, pulire
                });
            } else {
                startVAD(); // startVAD imposterà isTransitioningAudio a false
            }
        }, 100); // Breve ritardo
    } else {
        console.log("resumeListeningAfterFernanda: sessione non attiva/valida, già in transizione, o terminata. Stato:", currentConversationState, "isTransitioningAudio:", isTransitioningAudio);
        if (!globalStream && currentConversationState !== 'idle') {
            console.warn("resumeListeningAfterFernanda: globalStream perso, ma stato non idle. Forzo pulizia.");
            cleanUpFullSession();
        } else if (isTransitioningAudio && currentConversationState === 'idle') {
            // Se è in transizione ma lo stato è diventato idle (es. per cleanUpFullSession), sblocca.
            isTransitioningAudio = false;
        }
    }
}

async function handleControlButtonClick() {
    console.log("handleControlButtonClick. Current state:", currentConversationState, "isTransitioningAudio:", isTransitioningAudio);

    // Sblocco audio per mobile alla prima interazione, se non già fatto
    if (currentConversationState === 'idle' && !window.audioPlaybackUnlockedViaInteraction) {
        console.log("Attempting non-blocking audio unlock for mobile...");
        let unlockAudioPlayer = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
        unlockAudioPlayer.volume = 0.001; // Quasi muto
        unlockAudioPlayer.play()
            .then(() => {
                console.log("Silent audio play() initiated for unlocking. Playback context likely active.");
                window.audioPlaybackUnlockedViaInteraction = true;
            })
            .catch((err) => {
                console.warn("Silent audio play() for unlocking failed or interrupted:", err.name, err.message, "(This is often not critical if main interaction proceeds)");
            })
            .finally(() => {
                unlockAudioPlayer = null; // Rilascia risorsa
            });
    }
    
    // Tentativo di riprendere AudioContext se sospeso (comune su mobile prima dell'interazione)
    if (audioContext && audioContext.state === 'suspended') {
        console.log("AudioContext (VAD) sospeso. Tentativo resume su click...");
        try {
            await audioContext.resume();
            console.log("AudioContext (VAD) resumed by user interaction.");
        } catch (e) {
            console.warn("Could not resume AudioContext (VAD) on click:", e);
        }
    }

    if (isTransitioningAudio && currentConversationState !== 'idle') { // Permetti di avviare da idle anche se isTransitioningAudio è true da un precedente cleanup
        console.log("handleControlButtonClick: click ignorato, isTransitioningAudio = true e non in idle");
        statusMessage.textContent = "Attendere prego...";
        return;
    }

    if (currentConversationState === 'idle') {
        isTransitioningAudio = true; // Blocca durante l'inizializzazione
        updateUI('idle', 'Avvio...', 'icon-mic', 'Inizializzazione audio...');
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD(); // startVAD gestirà isTransitioningAudio
        } else {
            isTransitioningAudio = false; // Sblocca se l'inizializzazione fallisce
            // UI già aggiornata da initializeAudioProcessing in caso di errore
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        console.log("User requested stop session (from listening/processing).");
        isTransitioningAudio = true; // Blocca durante la pulizia
        updateUI(currentConversationState, 'Stop...', controlButton.querySelector('span').className, 'Terminazione sessione...');
        cleanUpFullSession(); // Resetta a idle e sblocca isTransitioningAudio
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        console.log("User requested interrupt Fernanda.");
        isTransitioningAudio = true; // Blocca durante l'interruzione e la ripresa
        updateUI('fernanda_speaking_continuous', 'Stop...', 'icon-stop', 'Interrompo Fernanda...');
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0; // Opzionale: riavvolge l'audio
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        // Non pulire tutta la sessione, riprendi solo ad ascoltare
        resumeListeningAfterFernanda(); // resumeListeningAfterFernanda gestirà isTransitioningAudio
    }
}

document.addEventListener('DOMContentLoaded', () => {
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
