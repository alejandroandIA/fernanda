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
let recordingMimeType = ''; // Stabile, impostato da initializeAudioProcessing
const baseRecordingFilename = 'user_vad_audio';

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
        
        recordingMimeType = preferredMimeType; // Imposta il MIME type globale
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

// Funzione helper per fermare e rilasciare solo MediaRecorder
function stopAndReleaseMediaRecorder() {
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
    if (!audioContext || !analyser || !globalStream || !microphoneSource) {
        console.error("AudioContext/analyser/globalStream/microphoneSource non inizializzato per VAD.");
        cleanUpFullSession(); // Se manca qualcosa di essenziale, pulisci tutto
        updateUI('idle', 'Errore Avvio', 'icon-mic', 'Errore avvio VAD. Ricarica.');
        return;
    }
    // Se esiste un MediaRecorder, fermalo e rilascialo prima di crearne uno nuovo
    stopAndReleaseMediaRecorder();

    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    // Usa il recordingMimeType globale, che è stato determinato in initializeAudioProcessing
    // e potenzialmente affinato dal primo avvio di MediaRecorder.
    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        console.log("Nuovo MediaRecorder creato. Requested MIME type:", options.mimeType || "Browser Default");

        // Questa logica aggiorna `recordingMimeType` se il browser ne sceglie uno diverso da quello richiesto.
        // È importante che `recordingMimeType` sia stabile e rifletta ciò che il browser usa effettivamente.
        if (mediaRecorderForVAD.mimeType) {
            if (recordingMimeType && mediaRecorderForVAD.mimeType !== recordingMimeType && recordingMimeType !== '') {
                 console.warn(`MediaRecorder userà ${mediaRecorderForVAD.mimeType} invece del richiesto ${recordingMimeType}.`);
            }
            // Aggiorna recordingMimeType globale se è diverso da quello che MediaRecorder sta effettivamente usando.
            // Questo è particolarmente importante la prima volta che MediaRecorder parte.
            if (mediaRecorderForVAD.mimeType !== recordingMimeType) {
                console.log(`Aggiornamento del recordingMimeType globale da "${recordingMimeType}" a quello effettivo del MediaRecorder: "${mediaRecorderForVAD.mimeType}"`);
                recordingMimeType = mediaRecorderForVAD.mimeType;
            }
        } else if (recordingMimeType) {
            console.warn(`MediaRecorder non ha riportato un mimeType effettivo, mantenendo il richiesto: ${recordingMimeType}`);
        } else {
            console.error("Critico: MediaRecorder non ha un mimeType effettivo e non ne è stato richiesto/determinato uno. La registrazione potrebbe fallire.");
        }
        console.log("Effective MIME type per questo MediaRecorder:", mediaRecorderForVAD.mimeType, "| Globale recordingMimeType:", recordingMimeType);

    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e, "Opzioni:", options);
        cleanUpFullSession();
        updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato o errore MediaRecorder.');
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0) {
            currentTurnAudioChunks.push(event.data);
        }
    };
    mediaRecorderForVAD.onstart = () => {
        console.log("MediaRecorder.onstart. Effective MIME type:", mediaRecorderForVAD.mimeType);
        // Conferma finale che recordingMimeType globale è allineato.
        if (mediaRecorderForVAD.mimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
            console.log(`Aggiornamento (onstart) del recordingMimeType globale a: "${mediaRecorderForVAD.mimeType}"`);
            recordingMimeType = mediaRecorderForVAD.mimeType;
        }
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder.onstop. Chunks raccolti:", currentTurnAudioChunks.length);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        // Non chiamare cleanUpFullSession qui direttamente, potrebbe essere troppo drastico
        // L'errore potrebbe essere gestito in modo più granulare.
        // Per ora, aggiorniamo l'UI e lasciamo che l'utente decida.
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Problema con la registrazione audio. Riprova.');
        stopAndReleaseMediaRecorder(); // Rilascia il recorder problematico
    };
    mediaRecorderForVAD.start(500);
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout); // Assicura un solo loop
    processAudioLoop();
}

function cleanUpFullSession() {
    console.log("Pulizia completa della sessione VAD.");
    if (vadProcessTimeout) {
        cancelAnimationFrame(vadProcessTimeout);
        vadProcessTimeout = null;
    }
    stopAndReleaseMediaRecorder(); // Ferma e nullifica mediaRecorderForVAD
    
    if (microphoneSource) {
        microphoneSource.disconnect(); // Disconnetti da analyser
        microphoneSource = null;
    }
    // Analyser non ha un metodo disconnect esplicito, ma non sarà più alimentato
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
    // recordingMimeType non viene resettato qui, perché è determinato da initializeAudioProcessing
    // e potrebbe essere riutilizzato se l'utente inizia una nuova conversazione senza ricaricare la pagina.
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
    console.log("Sessione VAD completamente pulita.");
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD) {
        // console.log("processAudioLoop: non in ascolto, analyser non pronto, o mediaRecorder non esiste. Esco.");
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

                    // Usa il recordingMimeType globale, che dovrebbe essere affidabile.
                    // Se mediaRecorderForVAD.mimeType è disponibile e diverso, potrebbe indicare un problema,
                    // ma per la creazione del blob, affidiamoci a recordingMimeType che è stato verificato.
                    const actualBlobMimeType = recordingMimeType || mediaRecorderForVAD?.mimeType || 'application/octet-stream';
                    
                    const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                    const fileExtension = getExtensionFromMimeType(actualBlobMimeType);
                    const filenameForApi = `${baseRecordingFilename}${fileExtension}`;

                    console.log('[DEBUG] ProcessAudioLoop - Invio audio:', {
                        blobSize: audioBlob.size,
                        blobType: audioBlob.type, // Tipo specificato nel Blob
                        derivedFromMimeType: actualBlobMimeType, // MIME type usato per derivare tipo ed estensione
                        mediaRecorderInstanceMimeType: mediaRecorderForVAD?.mimeType, // MIME type dell'istanza corrente del recorder
                        globalReferenceMimeType: recordingMimeType, // MIME type di riferimento globale
                        fileExtension: fileExtension,
                        filenameForApi: filenameForApi,
                        chunksLength: chunksToSend.length
                    });
                    
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
            displayErrorMessage = rawErrorMessage; // Usa direttamente l'errore dettagliato dall'API
        } else {
            displayErrorMessage = rawErrorMessage; // O il messaggio generico
        }
        
        console.error('Errore trascrizione (VAD):', displayErrorMessage, error);
        statusMessage.textContent = `Errore: ${displayErrorMessage}. Riprova parlando.`; // "Errore:" qui
        setTimeout(resumeListeningAfterFernanda, 2500);
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
        const MAX_HISTORY_TURNS = 10; // 10 turni (utente + assistente = 20 messaggi)
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
        statusMessage.textContent = `Oops: ${error.message}. Riprova parlando.`; // "Oops:" qui
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
        // Non cambiare UI qui, startVAD lo farà
        
        // La logica ora è: sempre fermare/rilasciare il vecchio e chiamare startVAD per crearne uno nuovo.
        // stopAndReleaseMediaRecorder(); // Già chiamato da startVAD ora, o lo farà se necessario
        
        if (globalStream && audioContext && analyser && microphoneSource) {
            console.log("Pronto per chiamare startVAD da resumeListeningAfterFernanda.");
            startVAD(); // Questo ora si occupa di fermare il vecchio recorder se esiste e crearne uno nuovo
        } else {
            console.error("Dipendenze mancanti per startVAD in resumeListening. Effettuo pulizia completa.");
            cleanUpFullSession(); 
            return;
        }
        // Il processAudioLoop viene avviato da startVAD
    } else {
        console.log("resumeListeningAfterFernanda: la sessione non è attiva o è stata terminata. Non si riprende l'ascolto.");
        if (!globalStream && currentConversationState !== 'idle') { 
             // Se globalStream è andato perso ma non siamo idle, è un errore, pulisci.
             cleanUpFullSession();
        } else if (!globalStream) {
            // Se globalStream è null e siamo idle, l'UI dovrebbe già essere corretta.
            updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
        }
    }
}

async function handleControlButtonClick() {
    if (currentConversationState === 'idle') {
        const ready = await initializeAudioProcessing();
        if (ready) {
            startVAD(); // startVAD ora si occupa anche di chiamare processAudioLoop
        }
    } else if (currentConversationState === 'listening_continuous' || 
               currentConversationState === 'processing_vad_chunk') {
        cleanUpFullSession();
    } else if (currentConversationState === 'fernanda_speaking_continuous') {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0; 
            if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
                 URL.revokeObjectURL(currentAudio.src);
            }
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
