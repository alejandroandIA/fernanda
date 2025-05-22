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
let audioContextUnlocked = false; // Flag per tracciare lo sblocco dell'AudioContext

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processing_vad_chunk' || isTransitioningAudio);
    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = isTransitioningAudio;
    }
    console.log("UI Update:", state, buttonText, statusText, "Transitioning:", isTransitioningAudio);
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
            console.warn(`Nessuna estensione nota per MIME type: ${mimeType}. Tentativo di fallback.`);
            if (typeSpecific.startsWith('audio/x-')) {
                const potentialExt = typeSpecific.substring(8);
                if (potentialExt.length > 0 && potentialExt.length <= 4) return `.${potentialExt}`;
            }
            return '.bin';
    }
}

async function unlockAudioContext(context) {
    if (context.state === 'suspended') {
        console.log('AudioContext is suspended, attempting to resume/unlock...');
        try {
            await context.resume();
            if (context.state === 'running') {
                console.log('AudioContext resumed successfully via resume().');
                audioContextUnlocked = true;
            } else {
                console.warn('AudioContext.resume() did not result in "running" state. Current state:', context.state, "Attempting fallback unlock.");
                // Fallback a riproduzione di suono silenzioso (più aggressivo)
                const buffer = context.createBuffer(1, 1, 22050);
                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(context.destination);
                source.start(0);
                source.onended = () => { // Attendi che il suono sia "finito"
                    if (context.state === 'running') {
                        console.log('AudioContext running after silent sound workaround.');
                        audioContextUnlocked = true;
                    } else {
                         console.warn('AudioContext still not running after silent sound. State:', context.state);
                    }
                };
            }
        } catch (e) {
            console.error('Error resuming or unlocking AudioContext:', e);
        }
    } else if (context.state === 'running') {
        console.log('AudioContext is already running.');
        audioContextUnlocked = true;
    } else {
        console.log('AudioContext state:', context.state);
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

        if (!audioContext || audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log("Nuovo AudioContext creato. Stato iniziale:", audioContext.state);
        }
        
        // Tenta di sbloccare/riprendere l'AudioContext dopo l'interazione utente (click) e creazione/controllo
        if (audioContext) {
            await unlockAudioContext(audioContext);
        } else {
            console.error("AudioContext non è stato creato. Impossibile sbloccare.");
            // Potrebbe essere necessario un fallback o un messaggio di errore all'utente
        }

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.minDecibels = -70;
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.6;
        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);

        let preferredMimeType = '';
        if (MediaRecorder.isTypeSupported('audio/wav')) preferredMimeType = 'audio/wav';
        else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) preferredMimeType = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) preferredMimeType = 'audio/mp4';
        else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) preferredMimeType = 'audio/ogg;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/m4a')) preferredMimeType = 'audio/m4a';
        else if (MediaRecorder.isTypeSupported('audio/aac')) preferredMimeType = 'audio/aac';
        else console.warn("Nessun formato MIME preferito supportato. Usando default browser.");
        
        recordingMimeType = preferredMimeType;
        console.log("VAD Init: Preferred MIME Type to request:", recordingMimeType || "Browser Default");
        return true;
    } catch (err) {
        console.error('Errore getUserMedia o AudioContext:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError') msg = 'Permesso microfono negato.';
        if (err.name === 'NotFoundError') msg = 'Nessun microfono trovato.';
        if (err.name === 'SecurityError') msg = 'Errore sicurezza microfono (es. iframe senza permesso).';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        return false;
    }
}

function stopAndReleaseMediaRecorder() {
    if (mediaRecorderForVAD) {
        if (mediaRecorderForVAD.state === "recording") {
            try {
                mediaRecorderForVAD.stop();
                console.log("MediaRecorder fermato.");
            } catch (e) {
                console.warn("Errore durante mediaRecorderForVAD.stop():", e.message);
            }
        }
        mediaRecorderForVAD.ondataavailable = null;
        mediaRecorderForVAD.onstart = null;
        mediaRecorderForVAD.onstop = null;
        mediaRecorderForVAD.onerror = null;
        mediaRecorderForVAD = null;
        console.log("Riferimento a MediaRecorder rimosso.");
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream || !microphoneSource) {
        console.error("AudioContext/analyser/globalStream/microphoneSource non inizializzato per VAD.");
        cleanUpFullSession();
        updateUI('idle', 'Errore Avvio', 'icon-mic', 'Errore avvio VAD. Ricarica.');
        return;
    }
    // Se l'audioContext è sospeso, prova a riprenderlo prima di iniziare il VAD
    // Anche se unlockAudioContext è già stato chiamato, lo stato potrebbe cambiare.
    if (audioContext.state === 'suspended') {
        console.warn("startVAD: AudioContext sospeso. Tentativo di ripresa...");
        audioContext.resume().then(() => {
            console.log("AudioContext ripreso in startVAD. Stato:", audioContext.state);
            if (audioContext.state !== 'running') {
                console.warn("startVAD: AudioContext non ancora running dopo resume.");
            }
            // Procedi comunque con l'avvio del VAD, analyser potrebbe funzionare anche se sospeso
            // per alcuni aspetti, ma è meglio se è 'running'.
            proceedWithVadStart();
        }).catch(e => {
            console.error("startVAD: Errore nel riprendere AudioContext:", e);
            proceedWithVadStart(); // Prova comunque
        });
    } else {
        proceedWithVadStart();
    }
}

function proceedWithVadStart() {
    stopAndReleaseMediaRecorder();
    isTransitioningAudio = false;
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("Nuovo MediaRecorder creato. Requested MIME type:", options.mimeType || "Browser Default", "Effective:", mediaRecorderForVAD.mimeType);

        if (mediaRecorderForVAD.mimeType) {
            if (recordingMimeType && mediaRecorderForVAD.mimeType !== recordingMimeType && recordingMimeType !== '') {
                 console.warn(`MediaRecorder userà ${mediaRecorderForVAD.mimeType} invece del richiesto ${recordingMimeType}.`);
            }
            if (mediaRecorderForVAD.mimeType !== recordingMimeType) {
                console.log(`Aggiornamento del recordingMimeType globale da "${recordingMimeType}" a "${mediaRecorderForVAD.mimeType}"`);
                recordingMimeType = mediaRecorderForVAD.mimeType;
            }
        } else if (recordingMimeType) {
            console.warn(`MediaRecorder non ha riportato un mimeType effettivo, mantenendo il richiesto: ${recordingMimeType}`);
        } else {
            console.error("Critico: MediaRecorder non ha un mimeType effettivo. La registrazione potrebbe fallire o usare un formato inatteso.");
        }

    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e, "Opzioni:", options);
        isTransitioningAudio = false;
        cleanUpFullSession();
        updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato o errore MediaRecorder.');
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) {
            currentTurnAudioChunks.push(event.data);
        }
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder.onstart. Effective MIME type:", mediaRecorderForVAD.mimeType);
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
        isTransitioningAudio = false;
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder.onstop. Chunks raccolti:", currentTurnAudioChunks.length);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        isTransitioningAudio = false;
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema con la registrazione audio. Riprova.');
        stopAndReleaseMediaRecorder();
    };
    mediaRecorderForVAD.start(500);
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
}

function cleanUpFullSession() {
    console.log("Pulizia completa della sessione VAD.");
    isTransitioningAudio = false;
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
    }
    stopAndReleaseMediaRecorder();
    
    if (microphoneSource) {
        microphoneSource.disconnect(); 
        microphoneSource = null;
    }
    analyser = null; 

    // NON chiudere l'AudioContext per impostazione predefinita.
    // Se lo si chiude, initializeAudioProcessing dovrà ricrearlo e sbloccarlo.
    // Tenerlo vivo (anche se sospeso) può rendere più facile audioContext.resume().
    /*
    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.warn("Errore chiusura AudioContext:", e));
        audioContext = null; // Forza ricreazione al prossimo avvio
        audioContextUnlocked = false; // Resetta se l'AudioContext viene chiuso
    }
    */

    if (globalStream) {
        globalStream.getTracks().forEach(track => track.stop());
        globalStream = null;
    }
    conversationHistory = [];
    currentTurnAudioChunks = [];
    speaking = false;
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("Sessione VAD completamente pulita.");
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD || isTransitioningAudio) {
        if(isTransitioningAudio) {
            // console.log("processAudioLoop: in transizione, skippo invio.");
        }
        if (currentConversationState === 'listening_continuous') {
             vadProcessTimeout = requestAnimationFrame(processAudioLoop);
        }
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
        }
        silenceStartTime = currentTime;
    } else {
        if (speaking) {
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;

                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = [];

                    if (isTransitioningAudio) {
                        console.warn("ProcessAudioLoop: rilevato isTransitioningAudio=true PRIMA dell'invio. Annullamento invio.");
                        vadProcessTimeout = requestAnimationFrame(processAudioLoop);
                        return;
                    }

                    const actualBlobMimeType = recordingMimeType || (mediaRecorderForVAD ? mediaRecorderForVAD.mimeType : '') || 'application/octet-stream';
                    const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                    const fileExtension = getExtensionFromMimeType(actualBlobMimeType);
                    const filenameForApi = `${baseRecordingFilename}${fileExtension}`;

                    console.log(`[DEBUG] ProcessAudioLoop - Invio audio. Size: ${audioBlob.size}, Type: ${actualBlobMimeType}, Filename: ${filenameForApi}`);
                    sendAudioForTranscription(audioBlob, filenameForApi); 
                    return; 
                } else {
                    console.log(`VAD: Parlato troppo breve (${speechDuration}ms) o nessun chunk (${currentTurnAudioChunks.length}).`);
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
    if (isTransitioningAudio) {
        console.warn("sendAudioForTranscription: rilevato isTransitioningAudio=true. Annullamento fetch.");
        resumeListeningAfterFernanda();
        return;
    }

    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);

    try {
        const transcribeResponse = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData
        });

        if (!transcribeResponse.ok) {
            let errorPayload;
            try {
                errorPayload = await transcribeResponse.json();
            } catch (e) {
                errorPayload = { error: `Trascrizione Fallita: ${transcribeResponse.status} ${transcribeResponse.statusText}` };
            }
            throw new Error(errorPayload.error || `Trascrizione Fallita: ${transcribeResponse.status}`);
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
        let displayErrorMessage = "Errore trascrizione.";
        const rawErrorMessage = error && error.message ? error.message : "Errore sconosciuto";
        displayErrorMessage = rawErrorMessage;
        
        console.error('Errore trascrizione (VAD):', displayErrorMessage, error);
        statusMessage.textContent = `Errore: ${displayErrorMessage}. Riprova parlando.`;
        if (rawErrorMessage.toLowerCase().includes("invalid file format")) {
             console.warn("Possibile errore di formato file dovuto a transizione rapida o MIME type errato.");
        }
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
            throw new Error(errData.error || `Errore Chat API: ${chatResponse.status} ${chatResponse.statusText}`);
        }
        const chatData = await chatResponse.json();
        const assistantReply = chatData.reply;
        console.log("Fernanda's text reply (VAD):", assistantReply);
        
        conversationHistory.push({ role: 'assistant', content: assistantReply });
        const MAX_HISTORY_TURNS = 10; 
        if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
            conversationHistory = conversationHistory.slice(conversationHistory.length - (MAX_HISTORY_TURNS * 2));
        }

        const ttsResponse = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: assistantReply })
        });
        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: "Errore API TTS (no JSON)" }));
            throw new Error(errData.error || `Errore TTS API: ${ttsResponse.status} ${ttsResponse.statusText}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        const audioUrl = URL.createObjectURL(audioFernandaBlob);
        await playFernandaAudio(audioUrl); // Aggiunto await qui

    } catch (error) {
        console.error('Errore nel flusso chat/tts (VAD):', error);
        statusMessage.textContent = `Oops: ${error.message}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

async function playFernandaAudio(audioUrl) { // Ora è async
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.onended = null; // Rimuovi vecchi listener
        currentAudio.onerror = null;
        if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
             URL.revokeObjectURL(currentAudio.src);
        }
        currentAudio = null; // Assicurati che sia null prima di riassegnare
    }

    // Assicurati che l'AudioContext (se esiste e utilizzato per output) sia attivo
    if (audioContext && audioContext.state === 'suspended') {
        console.log("playFernandaAudio: AudioContext sospeso, tentativo di resume.");
        try {
            await audioContext.resume();
            if (audioContext.state === 'running') {
                console.log("playFernandaAudio: AudioContext ripreso con successo.");
            } else {
                console.warn("playFernandaAudio: AudioContext.resume() non ha cambiato stato a running. Stato attuale:", audioContext.state);
                // Potrebbe essere necessario un intervento utente più diretto se resume fallisce persistentemente
            }
        } catch (e) {
            console.error("playFernandaAudio: Errore nel riprendere AudioContext:", e);
            // Non bloccare la riproduzione, l'elemento Audio potrebbe funzionare comunque
        }
    }
    
    currentAudio = new Audio(audioUrl);
    isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');
    
    currentAudio.onended = () => {
        console.log("Fernanda finished speaking (VAD).");
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
        }
        currentAudio = null; // Nullo dopo revoca e fine
        if (currentConversationState === 'fernanda_speaking_continuous') { // Solo se non interrotta
            resumeListeningAfterFernanda();
        }
    };

    currentAudio.onerror = (e) => {
        console.error("Errore audio playback (VAD):", e, currentAudio.error);
        isFernandaSpeaking = false;
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src);
        }
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = 'Problema audio. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    };

    try {
        await currentAudio.play(); // .play() restituisce una Promise
        console.log("currentAudio.play() chiamato con successo.");
    } catch (error) {
        console.error("Autoplay bloccato o errore play (VAD):", error);
        isFernandaSpeaking = false; 
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src); 
        }
        currentAudio = null;

        let playErrorMsg = 'Audio bloccato. Riprova parlando.';
        if (error.name === 'NotAllowedError') {
            playErrorMsg = 'Audio bloccato dal browser. Potrebbe essere necessario un altro tocco o abilitare audio nelle impostazioni del sito.';
            // Qui potresti voler mostrare un pulsante "Riproduci audio" all'utente
            // per un'interazione diretta per sbloccare la riproduzione.
        } else if (error.name === 'AbortError') {
            playErrorMsg = 'Riproduzione audio interrotta.'; // Es. se l'utente naviga via
        }
        
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = playErrorMsg;
            setTimeout(resumeListeningAfterFernanda, 1500); // Dare più tempo
        } else {
             // Se lo stato non è più fernanda_speaking_continuous (es. utente ha interrotto), non fare nulla
             console.log("Riproduzione fallita ma lo stato è cambiato, non si riprende l'ascolto qui.");
        }
    }
}

function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda chiamato. Stato corrente:", currentConversationState, "GlobalStream:", !!globalStream);
    if (currentConversationState !== 'idle' && globalStream) {
        isTransitioningAudio = true;
        console.log("Impostato isTransitioningAudio = true");
        currentTurnAudioChunks = [];
        
        setTimeout(() => {
            if (globalStream && audioContext && analyser && microphoneSource) {
                console.log("Pronto per chiamare startVAD da resumeListeningAfterFernanda (dopo timeout).");
                startVAD(); 
            } else {
                console.error("Dipendenze mancanti per startVAD in resumeListening (dopo timeout). Pulizia.", 
                              {gs:!!globalStream, ac:!!audioContext, an:!!analyser, ms:!!microphoneSource});
                isTransitioningAudio = false;
                cleanUpFullSession(); 
            }
        }, 100); // Aumentato leggermente il ritardo per stabilizzazione

    } else {
        console.log("resumeListeningAfterFernanda: la sessione non è attiva/globalStream assente o è stata terminata. Non si riprende l'ascolto.");
        if (!globalStream && currentConversationState !== 'idle') { 
             cleanUpFullSession(); // Pulisce se lo stream è andato ma lo stato non è idle
        } else if (!globalStream && currentConversationState === 'idle') {
            // Già idle e senza stream, UI dovrebbe essere corretta.
        } else if (currentConversationState === 'idle') {
            // Già idle, non fare nulla.
        }
    }
}

async function handleControlButtonClick() {
    if (isTransitioningAudio) {
        console.log("handleControlButtonClick: click ignorato, isTransitioningAudio = true");
        return;
    }

    if (currentConversationState === 'idle') {
        isTransitioningAudio = true; // Inizia transizione per l'avvio
        const ready = await initializeAudioProcessing(); // initializeAudioProcessing è async
        if (ready) {
            startVAD(); // startVAD resetterà isTransitioningAudio a false al suo interno
        } else {
            isTransitioningAudio = false; // Errore init, resetta flag
            // UI è già aggiornata da initializeAudioProcessing in caso di errore
        }
    } else if (currentConversationState === 'listening_continuous' || 
               currentConversationState === 'processing_vad_chunk') {
        isTransitioningAudio = true;
        cleanUpFullSession(); // cleanUpFullSession resetterà isTransitioningAudio e aggiornerà UI
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        // isTransitioningAudio sarà gestito da resumeListeningAfterFernanda e startVAD
        // Non impostare isTransitioningAudio = true qui subito, altrimenti
        // currentAudio.pause() potrebbe non essere eseguito se resumeListeningAfterFernanda
        // lo imposta subito. L'interruzione di Fernanda è un'azione immediata.
        
        console.log("Interruzione di Fernanda richiesta.");
        if (currentAudio) {
            currentAudio.pause();
            // Non impostare currentAudio.currentTime = 0; se si vuole che onended non scatti
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
                 URL.revokeObjectURL(currentAudio.src);
            }
            currentAudio = null; // Importante per evitare che onended scatti dopo
        }
        isFernandaSpeaking = false; // Fondamentale per fermare la logica di resume
        
        // Lo stato UI e la ripresa dell'ascolto sono gestiti da resumeListeningAfterFernanda
        // che viene chiamato implicitamente se non qui, ma è meglio essere espliciti
        // che vogliamo tornare ad ascoltare.
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
