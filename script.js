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
let isTransitioningAudio = false; // NUOVO FLAG per gestire le transizioni rapide

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'processing_vad_chunk' || isTransitioningAudio); // Disabilita anche durante la transizione
    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
        controlButton.disabled = isTransitioningAudio; // Disabilita anche durante la transizione
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

async function initializeAudioProcessing() {
    // ... (codice invariato, per brevità lo ometto qui, ma deve esserci nel file finale)
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
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        controlButton.disabled = true;
        return false;
    }
}

function stopAndReleaseMediaRecorder() {
    // ... (codice invariato)
    if (mediaRecorderForVAD) {
        if (mediaRecorderForVAD.state === "recording") {
            try {
                mediaRecorderForVAD.stop();
                console.log("MediaRecorder fermato prima della potenziale ricreazione.");
            } catch (e) {
                console.warn("Errore durante mediaRecorderForVAD.stop() in stopAndReleaseMediaRecorder:", e.message);
            }
        }
        mediaRecorderForVAD.ondataavailable = null;
        mediaRecorderForVAD.onstart = null;
        mediaRecorderForVAD.onstop = null;
        mediaRecorderForVAD.onerror = null;
        mediaRecorderForVAD = null;
        console.log("Riferimento a MediaRecorder precedente rimosso (impostato a null).");
    }
}

function startVAD() {
    // ... (gran parte invariato, ma con gestione di isTransitioningAudio)
    if (!audioContext || !analyser || !globalStream || !microphoneSource) {
        console.error("AudioContext/analyser/globalStream/microphoneSource non inizializzato per VAD.");
        cleanUpFullSession();
        updateUI('idle', 'Errore Avvio', 'icon-mic', 'Errore avvio VAD. Ricarica.');
        return;
    }
    stopAndReleaseMediaRecorder();

    isTransitioningAudio = false; // Fine transizione, ora si può iniziare ad ascoltare
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = []; // Assicura che i chunk siano vuoti all'inizio

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("Nuovo MediaRecorder creato. Requested MIME type:", options.mimeType || "Browser Default");

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
            console.error("Critico: MediaRecorder non ha un mimeType effettivo. La registrazione potrebbe fallire.");
        }
        console.log("Effective MIME type per MediaRecorder:", mediaRecorderForVAD.mimeType, "| Globale recordingMimeType:", recordingMimeType);

    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e, "Opzioni:", options);
        isTransitioningAudio = false; // Resetta flag in caso di errore
        cleanUpFullSession();
        updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato o errore MediaRecorder.');
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0 && !isTransitioningAudio) { // Non raccogliere chunk durante la transizione
            currentTurnAudioChunks.push(event.data);
        }
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder.onstart. Effective MIME type:", mediaRecorderForVAD.mimeType);
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.log(`Aggiornamento (onstart) del recordingMimeType globale a: "${mediaRecorderForVAD.mimeType}"`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
        isTransitioningAudio = false; // Sicurezza: la registrazione è iniziata, la transizione è finita.
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder.onstop. Chunks raccolti:", currentTurnAudioChunks.length);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        isTransitioningAudio = false; // Resetta flag
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema con la registrazione audio. Riprova.');
        stopAndReleaseMediaRecorder();
    };
    mediaRecorderForVAD.start(500);
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
}

function cleanUpFullSession() {
    // ... (codice invariato)
    console.log("Pulizia completa della sessione VAD.");
    isTransitioningAudio = false; // Assicura che il flag sia resettato
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

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.warn("Errore chiusura AudioContext:", e));
        audioContext = null;
    }
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
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD || isTransitioningAudio) { // AGGIUNTO isTransitioningAudio
        // Se siamo in transizione, non processare/inviare audio
        if(isTransitioningAudio) {
            // console.log("processAudioLoop: in transizione, skippo invio.");
        }
        // Richiama il loop per continuare a controllare lo stato, ma non fare altro
        if (currentConversationState === 'listening_continuous' && !isTransitioningAudio) {
             // Solo se dovremmo ascoltare e NON siamo in transizione, ma qualcosa manca (analyser/recorder)
        } else if (currentConversationState === 'listening_continuous') {
            // Se stiamo ascoltando, continuiamo a chiamare il loop
             vadProcessTimeout = requestAnimationFrame(processAudioLoop);
        }
        return;
    }

    // ... (Logica RMS invariata)
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
                    currentTurnAudioChunks = []; // Svuota subito dopo aver copiato

                    // Verifica nuovamente il flag prima dell'invio effettivo
                    if (isTransitioningAudio) {
                        console.warn("ProcessAudioLoop: rilevato isTransitioningAudio=true PRIMA dell'invio. Annullamento invio.");
                        vadProcessTimeout = requestAnimationFrame(processAudioLoop); // Continua il loop
                        return;
                    }

                    const actualBlobMimeType = recordingMimeType || mediaRecorderForVAD?.mimeType || 'application/octet-stream';
                    const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                    const fileExtension = getExtensionFromMimeType(actualBlobMimeType);
                    const filenameForApi = `${baseRecordingFilename}${fileExtension}`;

                    console.log('[DEBUG] ProcessAudioLoop - Invio audio:', { /* ... dati ... */ });
                    sendAudioForTranscription(audioBlob, filenameForApi); 
                    return; 
                } else {
                    console.log("VAD: Parlato troppo breve o nessun chunk.", /* ... dati ... */);
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
    // ... (codice invariato)
    if (audioBlob.size === 0) {
        console.warn("Blob audio vuoto, non invio.");
        resumeListeningAfterFernanda();
        return;
    }
    // Controlla il flag un'ultima volta prima della fetch
    if (isTransitioningAudio) {
        console.warn("sendAudioForTranscription: rilevato isTransitioningAudio=true. Annullamento fetch.");
        resumeListeningAfterFernanda(); // Riprendi l'ascolto invece di inviare
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
        
        if (rawErrorMessage.toLowerCase().includes("invalid file format") || rawErrorMessage.includes("[OpenAI Code:")) {
            displayErrorMessage = rawErrorMessage;
        } else {
            displayErrorMessage = rawErrorMessage; 
        }
        
        console.error('Errore trascrizione (VAD):', displayErrorMessage, error);
        statusMessage.textContent = `Errore: ${displayErrorMessage}. Riprova parlando.`;
        // Se l'errore è di formato file, potrebbe essere dovuto alla transizione.
        // Diamo un feedback e proviamo a riprendere.
        if (rawErrorMessage.toLowerCase().includes("invalid file format")) {
             console.warn("Possibile errore di formato file dovuto a transizione rapida.");
        }
        setTimeout(resumeListeningAfterFernanda, 1500); // Aumentato leggermente il timeout
    }
}

async function processChatWithFernanda(transcript) {
    // ... (codice invariato)
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
        playFernandaAudio(audioUrl);

    } catch (error) {
        console.error('Errore nel flusso chat/tts (VAD):', error);
        statusMessage.textContent = `Oops: ${error.message}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

function playFernandaAudio(audioUrl) {
    // ... (codice invariato)
    if (currentAudio) {
        currentAudio.pause();
        if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
             URL.revokeObjectURL(currentAudio.src);
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
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            resumeListeningAfterFernanda();
        }
    };
    currentAudio.onerror = (e) => {
        console.error("Errore audio playback (VAD):", e);
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
    currentAudio.play().catch(error => {
        console.error("Autoplay bloccato o errore play (VAD):", error);
        isFernandaSpeaking = false; 
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src); 
        }
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = 'Audio bloccato. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    });
}

function resumeListeningAfterFernanda() {
    console.log("resumeListeningAfterFernanda chiamato. Stato corrente:", currentConversationState);
    if (currentConversationState !== 'idle' && globalStream) {
        isTransitioningAudio = true; // IMPOSTA FLAG DI TRANSIZIONE
        console.log("Impostato isTransitioningAudio = true");
        currentTurnAudioChunks = []; // Svuota i chunk per sicurezza
        
        // Considera un piccolo timeout per permettere allo stato audio di stabilizzarsi
        // Questo è opzionale e da testare.
        setTimeout(() => {
            if (globalStream && audioContext && analyser && microphoneSource) {
                console.log("Pronto per chiamare startVAD da resumeListeningAfterFernanda (dopo timeout).");
                // startVAD resetterà isTransitioningAudio a false quando sarà pronto
                startVAD(); 
            } else {
                console.error("Dipendenze mancanti per startVAD in resumeListening (dopo timeout). Pulizia.");
                isTransitioningAudio = false; // Resetta comunque il flag
                cleanUpFullSession(); 
                return;
            }
        }, 50); // Breve ritardo di 50ms, puoi provare ad aumentarlo/diminuirlo o rimuoverlo

    } else {
        // ... (logica di cleanup se la sessione non è attiva, invariata)
        console.log("resumeListeningAfterFernanda: la sessione non è attiva o è stata terminata. Non si riprende l'ascolto.");
        if (!globalStream && currentConversationState !== 'idle') { 
             cleanUpFullSession();
        } else if (!globalStream) {
            updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
        }
    }
}

async function handleControlButtonClick() {
    if (isTransitioningAudio) { // Se siamo in transizione, non fare nulla
        console.log("handleControlButtonClick: click ignorato, isTransitioningAudio = true");
        return;
    }

    if (currentConversationState === 'idle') {
        isTransitioningAudio = true; // Inizia transizione per l'avvio
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD(); // startVAD resetterà isTransitioningAudio
        } else {
            isTransitioningAudio = false; // Errore init, resetta flag
        }
    } else if (currentConversationState === 'listening_continuous' || 
               currentConversationState === 'processing_vad_chunk') {
        isTransitioningAudio = true; // Transizione per terminare
        cleanUpFullSession(); // cleanUpFullSession resetterà isTransitioningAudio
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        isTransitioningAudio = true; // Transizione per interrompere Fernanda
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0; 
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
                 URL.revokeObjectURL(currentAudio.src);
            }
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        // isTransitioningAudio sarà gestito da resumeListeningAfterFernanda e startVAD
        resumeListeningAfterFernanda(); 
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

// ... (Setup iniziale UI invariato)
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
} else {
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}
