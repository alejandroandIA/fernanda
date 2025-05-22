// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

// --- VAD (Voice Activity Detection) Variables ---
let audioContext;
let analyser;
let microphoneSource;
const VAD_SILENCE_THRESHOLD = 0.01; // Potrebbe necessitare di aggiustamenti
const VAD_SILENCE_DURATION_MS = 1800; // Potrebbe necessitare di aggiustamenti
const VAD_SPEECH_MIN_DURATION_MS = 300;
let silenceStartTime = 0;
let speaking = false;
let speechStartTime = 0;
let globalStream = null;
let vadProcessTimeout = null; // Handle per requestAnimationFrame

let currentTurnAudioChunks = [];
let mediaRecorderForVAD;
let recordingMimeType = ''; // Determinato dinamicamente
const baseRecordingFilename = 'user_vad_audio';

// --- Cronologia Conversazione ---
let conversationHistory = [];

// --- Stati UI e Gestione Audio Fernanda ---
let currentAudio = null; // Oggetto Audio per la voce di Fernanda
let isFernandaSpeaking = false;
let currentConversationState = 'idle';
let isTransitioningAudio = false; // Flag per prevenire azioni multiple durante transizioni
window.audioPlaybackUnlockedViaInteraction = false; // Flag per sblocco audio su mobile

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    
    // Gestione disabilitazione bottone:
    // In generale, disabilitato se in transizione o se sta processando un chunk VAD.
    // Eccezione: se Fernanda sta parlando, il bottone (Interrompi Fernanda) deve essere abilitato
    // per permettere l'interruzione, a meno che non sia in una transizione critica (es. cleanup sessione).
    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        // Se Fernanda sta parlando, il bottone è per interromperla.
        // isTransitioningAudio potrebbe essere true brevemente (es. all'inizio della sua parlata o se l'utente clicca per interrompere)
        // quindi non disabilitiamo SEMPRE. Disabilitiamo solo se la transizione è per un'altra operazione.
        // Per semplicità, lo lasciamo abilitato a meno che non sia una transizione molto specifica.
        // La logica in handleControlButtonClick gestirà il comportamento corretto.
        controlButton.disabled = false; 
    } else {
        controlButton.disabled = (state === 'processing_vad_chunk' || isTransitioningAudio);
    }
    // console.log("UI Update:", state, "Button Text:", buttonText, "Status:", statusText, "Transitioning:", isTransitioningAudio, "Button Disabled:", controlButton.disabled);
}


function getExtensionFromMimeType(mimeType) {
    // console.log("[getExtensionFromMimeType] Input MIME type:", mimeType);
    if (!mimeType) {
        // console.warn("[getExtensionFromMimeType] MIME type nullo o vuoto, fallback a .bin");
        return '.bin';
    }
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    let extension;
    switch (typeSpecific) {
        case 'audio/wav': case 'audio/wave': extension = '.wav'; break;
        case 'audio/mpeg': extension = '.mp3'; break;
        case 'audio/webm': extension = '.webm'; break;
        case 'audio/opus': extension = '.opus'; break;
        case 'audio/mp4':
            extension = '.m4a'; // Preferiamo .m4a per audio/mp4 come da specifiche Apple
            // console.log("[getExtensionFromMimeType] audio/mp4 rilevato, usando estensione .m4a");
            break;
        case 'audio/m4a': extension = '.m4a'; break; // Esplicito m4a
        case 'audio/ogg': extension = '.ogg'; break;
        case 'audio/aac': extension = '.aac'; break;
        default:
            // console.warn(`[getExtensionFromMimeType] Nessuna estensione nota per MIME: ${mimeType}. Tentativo fallback.`);
            if (typeSpecific.startsWith('audio/x-')) { // Es: audio/x-m4a
                const potentialExt = typeSpecific.substring(8);
                if (potentialExt.length > 0 && potentialExt.length <= 4) {
                    extension = `.${potentialExt}`;
                    // console.log(`[getExtensionFromMimeType] Fallback audio/x- a: ${extension}`);
                    break;
                }
            }
            if (mimeType.includes('opus') && !typeSpecific.includes('webm') && !typeSpecific.includes('ogg')) { // A volte opus è solo audio/opus
                 extension = '.opus';
                 // console.log(`[getExtensionFromMimeType] MIME type include 'opus' (senza webm/ogg), usando .opus`);
                 break;
            }
            extension = '.bin'; // Fallback estremo
            // console.log(`[getExtensionFromMimeType] Fallback finale a: ${extension}`);
    }
    // console.log("[getExtensionFromMimeType] Output estensione:", extension);
    return extension;
}

async function initializeAudioProcessing() {
    console.log("Initializing audio processing...");
    // isTransitioningAudio è già true da handleControlButtonClick
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

        if (!window.AudioContext && !window.webkitAudioContext) {
            console.error("AudioContext non supportato da questo browser.");
            updateUI('idle', 'Non Supportato', 'icon-mic', 'AudioContext non supportato.');
            controlButton.disabled = true;
            isTransitioningAudio = false;
            if (globalStream) globalStream.getTracks().forEach(track => track.stop());
            globalStream = null;
            return false;
        }
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext created. Initial state:", audioContext.state);

        // Tenta di riprendere l'AudioContext se sospeso (comune prima dell'interazione utente)
        if (audioContext.state === 'suspended') {
            console.log("AudioContext is suspended, attempting to resume...");
            try {
                await audioContext.resume();
                console.log("AudioContext resumed successfully. New state:", audioContext.state);
            } catch (resumeError) {
                console.warn("Failed to resume AudioContext during initialization:", resumeError);
                // Non fatale qui, potrebbe riprendersi con l'interazione del bottone
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

        // Determinazione del MIME type per la registrazione
        let preferredMimeType = '';
        // Ordine di preferenza: WAV (per qualità se supportato), MP4 (M4A per Safari), WebM/Opus, Ogg/Opus, AAC, MP3
        const mimeTypesToTest = [
            'audio/wav',                // Massima qualità, ma file grandi
            'audio/mp4',                // Safari lo registra come M4A. Buona compatibilità.
            'audio/webm;codecs=opus',   // Ottimo formato, ma supporto variabile
            'audio/ogg;codecs=opus',    // Simile a WebM/Opus
            'audio/aac',                // Buona qualità e compressione
            'audio/mpeg',               // MP3, ampiamente supportato
        ];
        console.log("[initializeAudioProcessing] Testing MIME types in order of preference:", mimeTypesToTest);

        for (const mime of mimeTypesToTest) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                console.log(`[initializeAudioProcessing] Supported MIME type found: ${preferredMimeType}`);
                break; // Trovato il primo preferito supportato
            } else {
                console.log(`[initializeAudioProcessing] MIME type NOT supported: ${mime}`);
            }
        }

        if (!preferredMimeType) {
            if (MediaRecorder.isTypeSupported('')) { // Se nessuno dei preferiti è supportato, prova con la stringa vuota (default del browser)
                console.warn("[initializeAudioProcessing] No preferred MIME type supported. Using browser default (empty string).");
                recordingMimeType = ''; // Lascia che sia il browser a decidere
            } else {
                console.error("[initializeAudioProcessing] CRITICAL: MediaRecorder supports no common formats nor browser default.");
                updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato.');
                controlButton.disabled = true;
                isTransitioningAudio = false;
                cleanUpFullSession(); // Pulisci ciò che è stato inizializzato
                return false;
            }
        } else {
            recordingMimeType = preferredMimeType;
        }

        console.log("[initializeAudioProcessing] Effective global recordingMimeType set to:", recordingMimeType || "Browser Default");
        // isTransitioningAudio sarà impostato su false da mediaRecorder.onstart o da un errore in startVAD
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
        console.log("Stopping/releasing MediaRecorder. Current state:", mediaRecorderForVAD.state);
        if (mediaRecorderForVAD.state === "recording" || mediaRecorderForVAD.state === "paused") {
            try { mediaRecorderForVAD.stop(); console.log("MediaRecorder.stop() called."); }
            catch (e) { console.warn("Error during mediaRecorderForVAD.stop():", e.message, e); }
        }
        // Rimuovi tutti i listener per prevenire memory leak o comportamenti inattesi
        mediaRecorderForVAD.ondataavailable = null;
        mediaRecorderForVAD.onstart = null;
        mediaRecorderForVAD.onstop = null;
        mediaRecorderForVAD.onerror = null;
        mediaRecorderForVAD = null; // Rilascia l'istanza
        console.log("MediaRecorder instance and listeners released.");
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream || !microphoneSource) {
        console.error("startVAD: Critical audio components not initialized. Aborting VAD start.");
        isTransitioningAudio = false; // Errore, termina transizione
        cleanUpFullSession();
        updateUI('idle', 'Errore Avvio VAD', 'icon-mic', 'Errore critico VAD. Ricarica.');
        return;
    }

    stopAndReleaseMediaRecorder(); // Assicura che il precedente recorder sia fermo
    currentTurnAudioChunks = [];
    speaking = false;
    silenceStartTime = performance.now();
    speechStartTime = 0;

    // Usa il recordingMimeType globale determinato durante l'inizializzazione
    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    console.log("[startVAD] Attempting MediaRecorder creation with options:", options);

    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log(`[startVAD] New MediaRecorder created. Requested MIME: "${options.mimeType || "Default"}", Actual MediaRecorder.mimeType: "${mediaRecorderForVAD.mimeType}"`);

        // Aggiorna il recordingMimeType globale se il browser ne ha scelto uno diverso o specifico,
        // o se il richiesto era vuoto e ora ne abbiamo uno effettivo.
        if (mediaRecorderForVAD.mimeType && (mediaRecorderForVAD.mimeType !== recordingMimeType || !recordingMimeType)) {
            console.log(`[startVAD] Updating global recordingMimeType from "${recordingMimeType}" to "${mediaRecorderForVAD.mimeType}".`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        } else if (!mediaRecorderForVAD.mimeType && recordingMimeType) {
            console.warn(`[startVAD] MediaRecorder did not report an effective mimeType, but a global one ("${recordingMimeType}") was set. Proceeding with the global one.`);
        } else if (!mediaRecorderForVAD.mimeType && !recordingMimeType) {
            console.error("[startVAD] CRITICAL: MediaRecorder has no effective MIME type, and no global/default was specified. Recording might fail or produce un-typed data.");
            // Potrebbe essere utile impostare un fallback qui, es. 'application/octet-stream', ma è rischioso.
        }
        console.log("[startVAD] Effective global recordingMimeType for this VAD session:", recordingMimeType);

    } catch (e) {
        console.error("Error creating MediaRecorder:", e.name, e.message, "Options used:", options, e);
        let errorMsg = 'Errore MediaRecorder.';
        if (e.name === 'SecurityError') errorMsg = 'Errore sicurezza MediaRecorder.';
        else if (e.name === 'NotSupportedError' || e.message.toLowerCase().includes('mime type')) errorMsg = `Formato audio (${recordingMimeType || 'default'}) non supportato.`;
        updateUI('idle', 'Errore Registratore', 'icon-mic', errorMsg);
        isTransitioningAudio = false; // Errore, termina transizione
        cleanUpFullSession();
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) {
            currentTurnAudioChunks.push(event.data);
            // console.log(`[MediaRecorder.ondataavailable] Chunk received. Size: ${event.data.size}. Total chunks: ${currentTurnAudioChunks.length}`);
        }
    };

    mediaRecorderForVAD.onstart = () => {
        console.log("[MediaRecorder.onstart] Triggered. Effective MediaRecorder.mimeType:", mediaRecorderForVAD.mimeType);
        // Aggiorna nuovamente il recordingMimeType globale se necessario (alcuni browser lo finalizzano solo onstart)
        if (mediaRecorderForVAD.mimeType && (mediaRecorderForVAD.mimeType !== recordingMimeType || !recordingMimeType)) {
            console.log(`[MediaRecorder.onstart] Updating global recordingMimeType from "${recordingMimeType}" to "${mediaRecorderForVAD.mimeType}".`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
        isTransitioningAudio = false; // La registrazione è iniziata, la transizione è finita
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
        console.log("[startVAD] MediaRecorder started. isTransitioningAudio set to false. UI updated to listening_continuous.");
    };

    mediaRecorderForVAD.onstop = () => {
        console.log(`[MediaRecorder.onstop] Triggered. Chunks collected before stop: ${currentTurnAudioChunks.length}, Total size: ${currentTurnAudioChunks.reduce((s, b) => s + b.size, 0)} bytes`);
    };

    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error ? event.error.name : "Unknown Error", event.error ? event.error.message : "No message", event);
        // Non mettere cleanUpFullSession qui per evitare loop se l'errore è persistente
        // ma resetta lo stato per permettere un nuovo tentativo manuale.
        isTransitioningAudio = false;
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema registrazione. Riprova.');
        stopAndReleaseMediaRecorder(); // Assicurati che il recorder sia rilasciato
        if (vadProcessTimeout) { // Ferma il loop VAD se era attivo
            cancelAnimationFrame(vadProcessTimeout);
            vadProcessTimeout = null;
        }
    };

    try {
        mediaRecorderForVAD.start(500); // Raccogli audio in chunk da 500ms
        console.log("[startVAD] MediaRecorder.start(500) called.");
    } catch (e) {
        console.error("Error on MediaRecorder.start():", e.name, e.message, e);
        updateUI('idle', 'Errore Avvio Reg.', 'icon-mic', 'Impossibile avviare registrazione.');
        isTransitioningAudio = false; // Errore, termina transizione
        cleanUpFullSession();
        return;
    }

    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
    console.log("[startVAD] VAD processing loop initiated.");
}


function cleanUpFullSession() {
    console.log("Cleaning up full VAD session...");
    const wasTransitioning = isTransitioningAudio;
    isTransitioningAudio = true; // Metti in stato di transizione durante la pulizia

    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
        console.log("VAD process loop (requestAnimationFrame) cancelled.");
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
            audioContext = null; // Rilascia solo dopo chiusura avvenuta
        }).catch(e => {
            console.warn("Error closing AudioContext:", e.message, e);
            audioContext = null; // Rilascia comunque il riferimento
        });
    } else if (audioContext) {
        audioContext = null; // Se già closed o riferimento esistente ma non valido
    }
    if (globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
        console.log("Global media stream tracks stopped and stream released.");
    }
    
    // Pulizia audio di Fernanda
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src?.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
            console.log("Fernanda's audio blob URL revoked during cleanup.");
        }
        currentAudio.onerror = null; // Rimuovi handler per evitare trigger tardivi
        currentAudio.onended = null;
        currentAudio = null;
    }
    isFernandaSpeaking = false;
    
    conversationHistory = [];
    currentTurnAudioChunks = [];
    speaking = false;
    
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("Sessione VAD pulita completamente, UI resettata a idle.");
    isTransitioningAudio = false; // Fine transizione di pulizia
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD || mediaRecorderForVAD.state !== "recording" || isTransitioningAudio) {
        // console.log(`[VAD_Loop_Guard] Skipping VAD tick. State: ${currentConversationState}, Analyser: ${!!analyser}, MediaRec: ${!!mediaRecorderForVAD}, RecState: ${mediaRecorderForVAD?.state}, Transitioning: ${isTransitioningAudio}`);
        if (currentConversationState === 'listening_continuous' && !isTransitioningAudio && mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
             vadProcessTimeout = requestAnimationFrame(processAudioLoop);
        }
        return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(dataArray);
    let sumOfSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const normSample = (dataArray[i] / 128.0) - 1.0;
        sumOfSquares += normSample * normSample;
    }
    const rms = Math.sqrt(sumOfSquares / dataArray.length);
    const currentTime = performance.now();

    // console.log(`[VAD_Tick] RMS: ${rms.toFixed(4)}, Speaking: ${speaking}, SilenceStartDelta: ${speaking ? (currentTime - silenceStartTime).toFixed(0) : 'N/A'}ms, Chunks: ${currentTurnAudioChunks.length}`);

    if (rms > VAD_SILENCE_THRESHOLD) {
        if (!speaking) {
            speaking = true;
            speechStartTime = currentTime;
            // console.log(`[VAD_Event] Speech Start detected (RMS: ${rms.toFixed(4)}).`);
        }
        silenceStartTime = currentTime;
    } else {
        if (speaking) {
            const silenceDuration = currentTime - silenceStartTime;
            // console.log(`[VAD_Event] Silence detected after speech (RMS: ${rms.toFixed(4)}). Current silence duration: ${silenceDuration.toFixed(0)}ms.`);
            if (silenceDuration > VAD_SILENCE_DURATION_MS) {
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;
                // console.log(`[VAD_Decision] End of speech detected. Total speech duration: ${speechDuration.toFixed(0)}ms.`);

                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    // console.log(`[VAD_Action] Sending audio. Speech duration (${speechDuration.toFixed(0)}ms) > min AND chunks (${currentTurnAudioChunks.length}) > 0.`);
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = [];
                    
                    isTransitioningAudio = true; // INIZIA TRANSIZIONE PER INVIO
                    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo audio...');
                    // console.log("[VAD_Action] Set isTransitioningAudio=true, UI updated to processing_vad_chunk.");
                    
                    let actualMimeTypeForBlob = recordingMimeType || mediaRecorderForVAD?.mimeType || 'application/octet-stream';
                    const determinedFileExtension = getExtensionFromMimeType(actualMimeTypeForBlob);
                    
                    if (determinedFileExtension === '.m4a' && !(actualMimeTypeForBlob.startsWith('audio/mp4') || actualMimeTypeForBlob.startsWith('audio/m4a'))) {
                        // console.log(`[VAD_BlobPrep] Forcing MIME to 'audio/mp4' for .m4a extension. Original: ${actualMimeTypeForBlob}`);
                        actualMimeTypeForBlob = 'audio/mp4';
                    } else if (determinedFileExtension === '.wav' && !actualMimeTypeForBlob.startsWith('audio/wav')) {
                        // console.log(`[VAD_BlobPrep] Forcing MIME to 'audio/wav' for .wav extension. Original: ${actualMimeTypeForBlob}`);
                        actualMimeTypeForBlob = 'audio/wav';
                    }

                    const filenameForApi = `${baseRecordingFilename}${determinedFileExtension}`;
                    // console.log(`[VAD_BlobPrep] Preparing to send. GlobalMIME: "${recordingMimeType}", RecorderMIME: "${mediaRecorderForVAD?.mimeType}", TypeForBlob: "${actualMimeTypeForBlob}", Ext: "${determinedFileExtension}", Filename: "${filenameForApi}"`);
                    
                    const audioBlob = new Blob(chunksToSend, { type: actualMimeTypeForBlob });
                    // console.log(`[VAD_BlobPrep] Blob created. Size: ${audioBlob.size}, Effective Type: ${audioBlob.type}`);

                    if (audioBlob.size === 0) {
                        console.warn("[VAD_Action] Audio blob is empty. Not sending. Resuming listening.");
                        statusMessage.textContent = 'Audio non rilevato. Riascolto.';
                        isTransitioningAudio = false; // FINE TRANSIZIONE (fallita)
                        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
                        return; 
                    }
                    
                    sendAudioForTranscription(audioBlob, filenameForApi); // Questa funzione gestirà isTransitioningAudio al suo termine
                    return; 
                } else {
                    // console.log(`[VAD_Action] Speech too short or no chunks. Discarding audio.`);
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
    // isTransitioningAudio è già true da processAudioLoop
    console.log(`[sendAudioForTranscription] Sending audio. Filename: '${filename}', Blob Type: '${audioBlob.type}', Size: ${audioBlob.size} bytes.`);

    const formData = new FormData();
    formData.append('audio', audioBlob, filename);
    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const responseBodyText = await transcribeResponse.text();
        if (!transcribeResponse.ok) {
            let errorPayload;
            try { errorPayload = JSON.parse(responseBodyText); }
            catch (e) { errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}. Server: ${responseBodyText}` }; }
            console.error("[sendAudioForTranscription] Transcription Error (Server):", transcribeResponse.status, errorPayload);
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
        }
        const { transcript } = JSON.parse(responseBodyText);
        console.log("[sendAudioForTranscription] Whisper transcript received:", transcript);

        if (!transcript || transcript.trim().length < 2) {
            console.log("[sendAudioForTranscription] Transcript too short or empty. Resuming listening.");
            statusMessage.textContent = 'Non ho colto bene. Ripeti?';
            isTransitioningAudio = false; // FINE TRANSIZIONE (per trascrizione)
            if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
            return;
        }
        conversationHistory.push({ role: 'user', content: transcript });
        // La transizione continua attraverso processChatWithFernanda
        await processChatWithFernanda(transcript); 
    } catch (error) {
        let displayErrorMessage = "Errore trascrizione.";
        const rawErrorMessage = error?.message || "Errore sconosciuto trascrizione";
        console.error('[sendAudioForTranscription] Catch Block Error:', rawErrorMessage, error);
        if (rawErrorMessage.toLowerCase().includes("invalid file format") || 
            rawErrorMessage.toLowerCase().includes("format is not supported") ||
            rawErrorMessage.includes("[OpenAI Code:")) {
            displayErrorMessage = `Errore formato audio: ${rawErrorMessage.substring(0, 100)}...`; 
        } else {
            displayErrorMessage = rawErrorMessage.substring(0, 100) + (rawErrorMessage.length > 100 ? "..." : "");
        }
        statusMessage.textContent = `${displayErrorMessage}. Riprova.`;
        isTransitioningAudio = false; // FINE TRANSIZIONE (per errore trascrizione)
        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
    }
}

async function processChatWithFernanda(transcript) {
    // isTransitioningAudio è ancora true
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda pensa...');
    console.log("[processChatWithFernanda] Sending transcript to chat API:", transcript);
    try {
        const chatResponse = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: transcript, history: conversationHistory }) });
        if (!chatResponse.ok) {
            const errData = await chatResponse.json().catch(() => ({ error: `Errore API Chat (${chatResponse.status})` }));
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("[processChatWithFernanda] Assistant reply:", assistantReply);

        if (!assistantReply || assistantReply.trim() === "") {
            console.warn("[processChatWithFernanda] Assistant reply is empty. Resuming listening.");
            statusMessage.textContent = "Fernanda non ha risposto. Riprova.";
            isTransitioningAudio = false; // FINE TRANSIZIONE (per chat)
            if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
            return;
        }
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

        updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Fernanda prepara audio...');
        console.log("[processChatWithFernanda] Requesting TTS for reply:", assistantReply);
        const ttsResponse = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: assistantReply }) });
        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: `Errore API TTS (${ttsResponse.status})` }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        console.log("[processChatWithFernanda] TTS audio blob received. Size:", audioFernandaBlob.size, "Type:", audioFernandaBlob.type);
        if (audioFernandaBlob.size === 0) throw new Error("Audio da Fernanda vuoto (TTS).");
        
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        // isTransitioningAudio rimane true, playFernandaAudio lo gestirà al termine o in caso di errore
        playFernandaAudio(audioUrl); 
    } catch (error) {
        console.error('[processChatWithFernanda] Catch Block Error:', error.message, error);
        statusMessage.textContent = `Oops, ${error.message.substring(0,100)}. Riprova.`;
        isTransitioningAudio = false; // FINE TRANSIZIONE (per errore chat/tts)
        if (currentConversationState !== 'idle') resumeListeningAfterFernanda();
    }
}

function playFernandaAudio(audioUrl) {
    // isTransitioningAudio è ancora true
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        console.log("[playFernandaAudio] Previous Fernanda audio stopped and revoked.");
    }
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    // Non impostare isTransitioningAudio = false qui. Lo faremo in onended/onerror o quando l'utente interrompe.
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');
    console.log("[playFernandaAudio] Playing Fernanda's audio. URL:", audioUrl.substring(0,50) + "...");

    currentAudio.onended = () => {
        console.log("[FernandaAudio.onended] Fernanda finished speaking.");
        isFernandaSpeaking = false;
        if (currentAudio?.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src); // Rilascia URL
        currentAudio = null;
        // Solo se non è stato interrotto/terminato da un'altra azione
        if (currentConversationState === 'fernanda_speaking_continuous') {
            isTransitioningAudio = false; // FINE TRANSIZIONE (Fernanda ha finito di parlare)
            resumeListeningAfterFernanda();
        } else {
            // Se lo stato è cambiato (es. utente ha premuto stop), isTransitioningAudio
            // sarà gestito da cleanUpFullSession o altra logica.
            isTransitioningAudio = false; 
        }
    };
    currentAudio.onerror = (e) => {
        console.error("[FernandaAudio.onerror] Error playing Fernanda's audio:", e, currentAudio?.error);
        isFernandaSpeaking = false;
        if (currentAudio?.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        let errMsg = 'Problema audio con Fernanda.';
        // Tenta di leggere il codice di errore se disponibile
        if (e.target && e.target.error && e.target.error.code) {
             errMsg += ` (Codice: ${e.target.error.code}, Messaggio: ${e.target.error.message})`;
        } else if (e.message) {
            errMsg += ` (${e.message})`;
        }
        statusMessage.textContent = `${errMsg} Riprova.`;

        if (currentConversationState === 'fernanda_speaking_continuous') {
            isTransitioningAudio = false; // FINE TRANSIZIONE (errore audio Fernanda)
            resumeListeningAfterFernanda();
        } else {
             isTransitioningAudio = false;
        }
    };

    currentAudio.play().then(() => {
        console.log("[FernandaAudio.play()] Playback started successfully.");
        // isTransitioningAudio rimane true finché non finisce o viene interrotto
    }).catch(error => {
        console.error("[FernandaAudio.play().catch] Error starting Fernanda's audio playback:", error);
        isFernandaSpeaking = false;
        if (currentAudio?.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
        currentAudio = null;
        statusMessage.textContent = `Riproduzione audio Fernanda fallita (${error.name}). Riprova.`;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            isTransitioningAudio = false; // FINE TRANSIZIONE (errore play() Fernanda)
            resumeListeningAfterFernanda();
        } else {
            isTransitioningAudio = false;
        }
    });
}

function resumeListeningAfterFernanda() {
    console.log(`[resumeListeningAfterFernanda] Called. Current State: ${currentConversationState}, GlobalStream: ${!!globalStream}, isTransitioningAudio: ${isTransitioningAudio}`);
    
    if (currentConversationState === 'idle' || !globalStream) {
        console.log("[resumeListeningAfterFernanda] Session was terminated or stream lost. Not resuming VAD. Cleaning up if not idle.");
        if (currentConversationState !== 'idle') cleanUpFullSession();
        // isTransitioningAudio sarà gestito da cleanUpFullSession o dovrebbe essere già false.
        return;
    }

    // Se non eravamo già in una transizione controllata (es. da onended di Fernanda)
    // e stiamo per iniziare una nuova transizione per riavviare il VAD.
    if (!isTransitioningAudio) {
        isTransitioningAudio = true;
        console.log("[resumeListeningAfterFernanda] Set isTransitioningAudio=true. Preparing to restart VAD.");
    } else {
        console.log("[resumeListeningAfterFernanda] Already in transition, proceeding to restart VAD.");
    }
    
    currentTurnAudioChunks = [];
    
    setTimeout(() => {
        if (currentConversationState === 'idle' || !globalStream) { // Ricontrolla stato prima di startVAD
            console.warn("[resumeListeningAfterFernanda > setTimeout] State became idle or stream lost before VAD restart. Aborting.");
            isTransitioningAudio = false; // Se non viene chiamato startVAD, resetta.
            if (currentConversationState !== 'idle') cleanUpFullSession();
            return;
        }
        if (!audioContext || audioContext.state === 'closed' || !analyser || !microphoneSource) {
            console.error("[resumeListeningAfterFernanda > setTimeout] Critical audio dependencies missing or closed. Aborting VAD restart and cleaning up.");
            cleanUpFullSession(); // Questo imposterà isTransitioningAudio = false
            return;
        }
        if (audioContext.state === 'suspended') {
            console.log("[resumeListeningAfterFernanda > setTimeout] AudioContext is suspended, attempting to resume before restarting VAD.");
            audioContext.resume().then(() => {
                console.log("[resumeListeningAfterFernanda > setTimeout] AudioContext resumed successfully. Starting VAD.");
                startVAD(); // startVAD gestirà isTransitioningAudio = false
            }).catch(err => {
                console.error("[resumeListeningAfterFernanda > setTimeout] Failed to resume AudioContext. Aborting VAD restart and cleaning up.", err);
                cleanUpFullSession();
            });
        } else {
            console.log("[resumeListeningAfterFernanda > setTimeout] AudioContext is active. Starting VAD.");
            startVAD(); // startVAD gestirà isTransitioningAudio = false
        }
    }, 50); // Breve ritardo, come nel tuo codice
}

async function handleControlButtonClick() {
    console.log(`[handleControlButtonClick] Clicked. Current State: ${currentConversationState}, isTransitioningAudio: ${isTransitioningAudio}, isFernandaSpeaking: ${isFernandaSpeaking}`);

    // Sblocco AudioContext e Playback al primo click significativo
    if (audioContext && audioContext.state === 'suspended') {
        try { 
            await audioContext.resume(); 
            console.log("[handleControlButtonClick] AudioContext resumed due to user interaction.");
        } catch (e) { 
            console.warn("[handleControlButtonClick] Could not resume AudioContext on click:", e);
        }
    }
    if (!window.audioPlaybackUnlockedViaInteraction) {
        console.log("[handleControlButtonClick] Attempting to unlock audio playback via dummy audio.");
        // Crea un elemento audio, imposta un sorgente base64 piccolissimo, e fai play.
        // Questo deve essere in risposta diretta a un evento utente.
        let unlockAudio = new Audio("data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA"); // Tiny WAV
        unlockAudio.volume = 0.001; // Quasi inaudibile
        unlockAudio.play().then(() => {
            window.audioPlaybackUnlockedViaInteraction = true;
            console.log("[handleControlButtonClick] Audio playback unlocked by dummy audio.");
        }).catch((e) => {
            console.warn("[handleControlButtonClick] Dummy audio playback failed to unlock or was blocked:", e.message);
            // Non è fatale, ma la riproduzione audio di Fernanda potrebbe fallire su alcuni dispositivi mobili.
        });
    }

    if (isTransitioningAudio && currentConversationState !== 'fernanda_speaking_continuous') {
        // Se Fernanda sta parlando, il click è per interromperla, quindi la transizione è attesa.
        // Altrimenti, se è in un'altra transizione, ignora il click.
        console.warn("[handleControlButtonClick] Click ignored: general transition in progress.");
        statusMessage.textContent = "Attendere prego...";
        return;
    }
    

    if (currentConversationState === 'idle') {
        console.log("[handleControlButtonClick] State is idle. Initializing audio processing and starting VAD.");
        isTransitioningAudio = true; // INIZIA TRANSIZIONE per avvio
        const ready = await initializeAudioProcessing();
        if (ready) {
            // startVAD imposterà isTransitioningAudio = false quando MediaRecorder parte
            startVAD();
        } else {
            console.error("[handleControlButtonClick] Audio initialization failed. VAD not started.");
            isTransitioningAudio = false; // FINE TRANSIZIONE (fallimento init)
            // L'UI dovrebbe essere già stata aggiornata da initializeAudioProcessing
        }
    } else if (currentConversationState === 'listening_continuous' || currentConversationState === 'processing_vad_chunk') {
        console.log(`[handleControlButtonClick] State is ${currentConversationState}. User requested to stop the session.`);
        isTransitioningAudio = true; // INIZIA TRANSIZIONE per stop
        updateUI(currentConversationState, 'Stop...', controlButton.querySelector('span').className, 'Terminazione in corso...');
        cleanUpFullSession(); // cleanUpFullSession imposterà isTransitioningAudio = false alla fine
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        console.log("[handleControlButtonClick] State is fernanda_speaking_continuous. User requested to interrupt Fernanda.");
        // Non impostiamo isTransitioningAudio = true subito qui, perché potrebbe essere già true
        // se l'interruzione avviene mentre Fernanda sta per iniziare a parlare.
        // Lo gestirà la logica interna.
        
        updateUI('fernanda_speaking_continuous', 'Stop...', 'icon-stop', 'Interrompo Fernanda...');
        
        if (currentAudio) {
            currentAudio.pause(); // Ferma la riproduzione
            if (currentAudio.src?.startsWith('blob:')) {
                URL.revokeObjectURL(currentAudio.src); // Rilascia subito la risorsa
                console.log("[handleControlButtonClick] Fernanda's audio paused and blob URL revoked due to user interrupt.");
            }
            currentAudio.onerror = null; // Rimuovi handler per evitare trigger tardivi
            currentAudio.onended = null;
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        
        // Dopo aver interrotto Fernanda, vogliamo tornare ad ascoltare.
        // resumeListeningAfterFernanda gestirà la transizione per riavviare il VAD.
        // isTransitioningAudio sarà impostato da resumeListeningAfterFernanda.
        if (!isTransitioningAudio) { // Solo se non siamo già in una transizione da playFernandaAudio
            isTransitioningAudio = true; // Segnala che stiamo per passare a resumeListening
        }
        resumeListeningAfterFernanda(); 
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM caricato. User Agent:", navigator.userAgent);
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined')) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic o Registrazione non supportati.');
        controlButton.disabled = true;
        console.error("Browser non supporta le API necessarie (getUserMedia o MediaRecorder).");
    } else {
        updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    }
    controlButton.addEventListener('click', handleControlButtonClick);
});
