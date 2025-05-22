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

function getExtensionFromMimeType(mimeType) {
    if (!mimeType) return '.bin';
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    switch (typeSpecific) {
        case 'audio/wav':
        case 'audio/wave': return '.wav';
        case 'audio/webm': return '.webm';
        case 'audio/opus': return '.opus'; // Spesso dentro webm o ogg
        case 'audio/mp4': return '.mp4';
        case 'audio/m4a': return '.m4a'; // m4a è spesso audio/mp4 o audio/aac
        case 'audio/ogg': return '.ogg';
        case 'audio/mpeg': return '.mp3';
        case 'audio/aac': return '.aac';
        default:
            console.warn(`Nessuna estensione nota per MIME type: ${mimeType}. Tentativo di fallback.`);
            // Per tipi come audio/x-matroska, audio/x-aac
            if (typeSpecific.startsWith('audio/x-')) {
                const potentialExt = typeSpecific.substring(8);
                if (potentialExt.length > 0 && potentialExt.length <= 4) return `.${potentialExt}`;
            }
            return '.bin'; // Fallback generico
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

        let preferredMimeType = '';
        // Priorità dei formati:
        if (MediaRecorder.isTypeSupported('audio/wav')) {
            preferredMimeType = 'audio/wav';
            console.log("VAD Init: Prioritizing WAV format for recording.");
        } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            preferredMimeType = 'audio/webm;codecs=opus';
            console.log("VAD Init: WAV not supported, trying webm/opus.");
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) { // Safari spesso usa questo (AAC in MP4)
            preferredMimeType = 'audio/mp4';
            console.log("VAD Init: WAV & webm/opus not supported, trying mp4.");
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
            preferredMimeType = 'audio/ogg;codecs=opus';
            console.log("VAD Init: WAV, webm/opus, mp4 not supported, trying ogg/opus.");
        } else if (MediaRecorder.isTypeSupported('audio/m4a')) { // Alternativa per Safari/Apple
             preferredMimeType = 'audio/m4a';
             console.log("VAD Init: Previous preferred not supported, trying m4a.");
        } else if (MediaRecorder.isTypeSupported('audio/aac')) { // Raramente supportato come contenitore, ma proviamo
            preferredMimeType = 'audio/aac';
            console.log("VAD Init: Previous preferred not supported, trying aac.");
        }
        else {
            preferredMimeType = ''; // Lascia che il browser scelga
            console.warn("VAD Init: Nessun formato MIME preferito (wav, webm, mp4, ogg, m4a, aac) supportato. Usando default browser.");
        }
        
        recordingMimeType = preferredMimeType;
        const initialExtension = getExtensionFromMimeType(recordingMimeType);
        console.log("VAD Init: Preferred MIME Type to request:", recordingMimeType || "Browser Default", "| Initial Filename based on preference:", `${baseRecordingFilename}${initialExtension}`);
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
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...'); // icon-stop-session non esiste
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("MediaRecorder for VAD created. Requested MIME type:", options.mimeType || "Browser Default");

        if (mediaRecorderForVAD.mimeType) {
            if (recordingMimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
                 console.warn(`MediaRecorder userà ${mediaRecorderForVAD.mimeType} invece del richiesto ${recordingMimeType}. Aggiornamento del MIME type di riferimento.`);
            }
            recordingMimeType = mediaRecorderForVAD.mimeType; 
        } else if (recordingMimeType) {
            console.warn(`MediaRecorder non ha riportato un mimeType effettivo, mantenendo il richiesto: ${recordingMimeType}`);
        } else {
            console.error("Critico: MediaRecorder non ha un mimeType effettivo e non ne è stato richiesto uno. Registrazione potrebbe fallire o produrre formato sconosciuto.");
            // Potrebbe essere saggio fermare qui o usare un fallback molto generico
            // Se recordingMimeType è vuoto (browser default), MediaRecorder.mimeType dovrebbe essere popolato.
            // Se ANCHE MediaRecorder.mimeType è vuoto, è un problema serio.
            if (!mediaRecorderForVAD.mimeType) { // Se è ancora vuoto dopo la creazione
                console.warn("MediaRecorder.mimeType è vuoto dopo la creazione. Il browser potrebbe non supportare la registrazione audio come configurata.");
                // Non è possibile derivare un'estensione affidabile. Si potrebbe tentare con un'estensione generica.
                // Ma è meglio fermare qui se il formato è completamente sconosciuto.
            }
        }
        console.log("Effective MIME type from MediaRecorder:", mediaRecorderForVAD.mimeType);


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
         // Assicura che recordingMimeType sia aggiornato con quello effettivo, ANCHE qui.
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.log(`Aggiornamento di recordingMimeType a quello effettivo all'onstart: ${mediaRecorderForVAD.mimeType}`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder for VAD stopped. Chunks:", currentTurnAudioChunks.length);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        stopVAD();
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema con la registrazione audio.');
    };
    mediaRecorderForVAD.start(500); // Raccogli chunk ogni 500ms
    processAudioLoop();
}

function stopVAD() {
    console.log("Tentativo di fermare VAD...");
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
    }
    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
        try {
            mediaRecorderForVAD.stop();
        } catch (e) {
            console.warn("Errore durante mediaRecorderForVAD.stop():", e.message);
        }
    }
    mediaRecorderForVAD = null; // Rimuovi riferimento
    // Non disconnettere microphoneSource qui se vuoi riavviare VAD senza reinizializzare tutto
    // Ma se stopVAD è inteso come "fine sessione parziale", allora va bene.
    // cleanUpFullSession si occupa della disconnessione completa.
    currentTurnAudioChunks = [];
    speaking = false;
    // Non aggiornare UI a 'idle' qui, altrimenti interrompe il flusso di "resumeListeningAfterFernanda"
    // L'UI viene gestita da chi chiama stopVAD o da cleanUpFullSession
    console.log("VAD parzialmente fermato (MediaRecorder).");
}

function cleanUpFullSession() {
    console.log("Pulizia completa della sessione VAD.");
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
    }
    if (mediaRecorderForVAD && mediaRecorderForVAD.state === "recording") {
        try {
            mediaRecorderForVAD.stop();
        } catch (e) {
            console.warn("Errore durante mediaRecorderForVAD.stop() in cleanUp:", e.message);
        }
    }
    mediaRecorderForVAD = null;
    
    if (microphoneSource) {
        microphoneSource.disconnect();
        microphoneSource = null;
    }
    if (analyser) {
        analyser = null; // Non ha un metodo disconnect, ma rimuovi riferimento
    }
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
    if (currentConversationState !== 'listening_continuous' || !analyser) {
        console.log("processAudioLoop: non in ascolto o analyser non pronto, esco.");
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
        silenceStartTime = currentTime; // Resetta timer silenzio mentre si parla
    } else { // Silenzio rilevato (RMS <= soglia)
        if (speaking) { // Se prima stava parlando
            if (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS) {
                console.log("VAD: Fine parlato (RMS:", rms.toFixed(3), ", Silenzio per", (currentTime - silenceStartTime).toFixed(0), "ms)");
                speaking = false;
                const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;

                if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                    console.log("VAD: Invio audio. Durata:", speechDuration.toFixed(0), "ms. Chunks:", currentTurnAudioChunks.length);
                    
                    const chunksToSend = [...currentTurnAudioChunks];
                    currentTurnAudioChunks = []; // Resetta per il prossimo turno

                    // Assicurati che recordingMimeType sia quello effettivo o un fallback
                    const actualBlobMimeType = mediaRecorderForVAD?.mimeType || recordingMimeType || 'application/octet-stream';
                    
                    const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                    const fileExtension = getExtensionFromMimeType(actualBlobMimeType); // Usa il MIME type del blob
                    const filenameForApi = `${baseRecordingFilename}${fileExtension}`;

                    console.log(`VAD: Preparazione invio. Blob type: ${audioBlob.type} (effettivo: ${actualBlobMimeType}), Size: ${audioBlob.size}, Filename per API: ${filenameForApi}`);
                    
                    // Non fermare MediaRecorder qui, lo faremo dopo la risposta di Fernanda
                    // o se l'utente clicca "Termina Conversazione"
                    sendAudioForTranscription(audioBlob, filenameForApi); 
                    return; // Esce dal loop, attende la trascrizione/risposta
                } else {
                    console.log("VAD: Parlato troppo breve o nessun chunk. Durata:", speechDuration.toFixed(0), "ms. Chunks:", currentTurnAudioChunks.length);
                    currentTurnAudioChunks = []; // Scarta i chunk
                    // Continua ad ascoltare
                }
            }
            // else: ancora nel periodo di tolleranza del silenzio, continua a considerarlo "parlato"
        } else { // Se era già in silenzio
            silenceStartTime = currentTime; // Continua a registrare il tempo di inizio del silenzio corrente
        }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) {
    if (audioBlob.size === 0) {
        console.warn("Blob audio vuoto, non invio.");
        resumeListeningAfterFernanda(); // Torna ad ascoltare
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
            // Prova a leggere il JSON, altrimenti usa il testo di stato
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
        // MODIFICA: Gestione dell'errore per una visualizzazione migliore
        let displayErrorMessage = "Errore trascrizione.";
        const rawErrorMessage = error && error.message ? error.message : "Errore sconosciuto";

        // Se il messaggio è già ben formattato dalla nostra API (es. inizia con [OpenAI Code...])
        if (rawErrorMessage.startsWith("[OpenAI Code:")) {
            displayErrorMessage = rawErrorMessage;
        } else {
            // Altrimenti, prova a vedere se è un JSON (improbabile qui dopo il throw new Error)
            // o semplicemente usa il messaggio così com'è.
            // La causa dell'errore originale è già stata trasformata in stringa.
            displayErrorMessage = rawErrorMessage;
        }
        
        console.error('Errore trascrizione (VAD):', displayErrorMessage, error); // Logga anche l'oggetto errore originale
        statusMessage.textContent = `Errore: ${displayErrorMessage}. Riprova parlando.`;
        setTimeout(resumeListeningAfterFernanda, 2500); // Più tempo per leggere l'errore
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
        const MAX_HISTORY_LENGTH = 20; // Numero di turni (utente + assistente)
        if (conversationHistory.length > MAX_HISTORY_LENGTH * 2) { // Ogni turno ha 2 messaggi
            conversationHistory = conversationHistory.slice(conversationHistory.length - (MAX_HISTORY_LENGTH * 2));
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
        if (currentConversationState === 'fernanda_speaking_continuous') { // Solo se non interrotta o terminata
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
        // Questo blocco catch è per l'errore .play() stesso
        isFernandaSpeaking = false; // Assicura che lo stato sia corretto
        if (currentAudio && currentAudio.src && currentAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(currentAudio.src); // Pulisci URL se il play fallisce
        }
        currentAudio = null;
        
        // Controlla se eravamo ancora nello stato di Fernanda che parla.
        // Se sì, l'utente non ha interrotto e c'è stato un problema di autoplay.
        if (currentConversationState === 'fernanda_speaking_continuous') {
            statusMessage.textContent = 'Audio bloccato. Riprova parlando.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    });
}

function resumeListeningAfterFernanda() {
    // Verifica se la sessione è ancora attiva (non 'idle' o terminata dall'utente)
    if (currentConversationState !== 'idle' && globalStream) {
        updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Tocca a te...'); // Usa icon-stop che esiste
        
        // Riattiva MediaRecorder se non è già attivo e se esiste
        if (mediaRecorderForVAD && mediaRecorderForVAD.state === "inactive") {
            currentTurnAudioChunks = []; // Pulisci i vecchi chunk
            try {
                mediaRecorderForVAD.start(500);
                console.log("MediaRecorder riavviato per il nuovo turno.");
            } catch (e) {
                console.error("Errore nel riavviare MediaRecorder:", e);
                cleanUpFullSession(); // Errore critico, pulisci tutto
                updateUI('idle', 'Errore Registratore', 'icon-mic', 'Problema a riavviare registrazione.');
                return;
            }
        } else if (!mediaRecorderForVAD) {
            // Questo non dovrebbe succedere se la sessione è continua.
            // Potrebbe indicare che startVAD non è stato completato o cleanUp è stato chiamato in modo imprevisto.
            console.warn("resumeListeningAfterFernanda: mediaRecorderForVAD non esiste. Tentativo di reinizializzazione leggera.");
            // Non chiamare initializeAudioProcessing() completo, ma prova a ricreare MediaRecorder
            // Se globalStream esiste ancora, possiamo provare a riavviare solo MediaRecorder
            if (globalStream) {
                startVAD(); // Questo potrebbe essere troppo pesante, ma tenta di recuperare
            } else {
                cleanUpFullSession(); // Se globalStream non c'è, la sessione è corrotta
                return;
            }
        }
        // Riattiva il loop di processamento audio
        if (!vadProcessTimeout) { // Evita di duplicare requestAnimationFrame
            processAudioLoop();
        }
    } else {
        console.log("resumeListeningAfterFernanda: la sessione non è attiva o è stata terminata. Non si riprende l'ascolto.");
        if (!globalStream) { // Se globalStream è null, la sessione è stata terminata
             updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
        }
    }
}


async function handleControlButtonClick() {
    if (currentConversationState === 'idle') {
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD();
        }
    } else if (currentConversationState === 'listening_continuous' || 
               currentConversationState === 'processing_vad_chunk') {
        // L'utente vuole terminare l'intera conversazione
        cleanUpFullSession();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        // L'utente vuole interrompere Fernanda e parlare
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0; // Opzionale: riavvolge l'audio
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
                 URL.revokeObjectURL(currentAudio.src);
            }
            currentAudio = null;
        }
        isFernandaSpeaking = false;
        // Non chiamare stopVAD() qui, perché vogliamo riprendere l'ascolto
        resumeListeningAfterFernanda(); // Questo cambierà l'UI e riattiverà l'ascolto
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

// Initial UI state
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
} else {
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}
