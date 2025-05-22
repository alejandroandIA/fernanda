// script.js
const controlButton = document.getElementById('controlButton');
const statusMessage = document.getElementById('statusMessage');

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
let recordingMimeType = ''; // MIME type effettivo usato dal MediaRecorder
const baseRecordingFilename = 'user_vad_audio';

let conversationHistory = [];

let currentAudio = null; // Per l'audio di Fernanda
let isFernandaSpeaking = false;
let currentConversationState = 'idle'; // Stati: 'idle', 'initializing', 'listening_continuous', 'processing_vad_chunk', 'fernanda_speaking_continuous', 'awaiting_play_permission'
let audioContextUnlocked = false;
let fernandaAudioUrlToPlay = null; // Per memorizzare l'URL dell'audio di Fernanda se l'autoplay fallisce

function updateUI(state, buttonText, buttonIconClass, statusText) {
    currentConversationState = state;
    controlButton.innerHTML = `<span class="${buttonIconClass}"></span>${buttonText}`;
    statusMessage.textContent = statusText || '';
    controlButton.disabled = (state === 'initializing' || state === 'processing_vad_chunk');

    if (state === 'fernanda_speaking_continuous') {
        controlButton.innerHTML = `<span class="icon-stop"></span>Interrompi Fernanda`;
    } else if (state === 'awaiting_play_permission') {
        controlButton.innerHTML = `<span class="icon-play"></span>Ascolta Fernanda`;
        controlButton.disabled = false; // Deve essere cliccabile
    }
    console.log("UI Update:", state, buttonText, statusText);
}

function getExtensionFromMimeType(mimeType) {
    if (!mimeType) return '.bin';
    const typeSpecific = mimeType.split(';')[0].toLowerCase();
    switch (typeSpecific) {
        case 'audio/webm': return '.webm'; // Opus è spesso dentro webm
        case 'audio/opus': return '.opus';
        case 'audio/ogg': return '.ogg';   // Opus può essere anche in ogg
        case 'audio/mp4': return '.mp4';   // AAC è spesso dentro mp4
        case 'audio/m4a': return '.m4a';
        case 'audio/aac': return '.aac';
        case 'audio/wav': case 'audio/wave': return '.wav';
        case 'audio/mpeg': return '.mp3';
        default:
            console.warn(`Nessuna estensione nota per MIME type: ${mimeType}. Usando '.bin'.`);
            return '.bin';
    }
}

async function unlockAudioContextIfNeeded() {
    if (!audioContext) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext creato. Stato iniziale:", audioContext.state);
        } catch (e) {
            console.error("Errore creazione AudioContext:", e);
            updateUI('idle', 'Errore Audio', 'icon-mic', 'Impossibile inizializzare audio.');
            controlButton.disabled = true;
            return false;
        }
    }
    if (audioContext.state === 'suspended') {
        console.log('AudioContext is suspended, attempting to resume...');
        try {
            await audioContext.resume();
            if (audioContext.state === 'running') {
                console.log('AudioContext resumed successfully.');
                audioContextUnlocked = true;
                return true;
            } else {
                console.warn('AudioContext.resume() did not result in "running" state.');
                // Tentativo con suono silenzioso (più aggressivo, ma a volte necessario su iOS più vecchi)
                const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
                const source = audioContext.createBufferSource();
                source.buffer = buffer;
                source.connect(audioContext.destination);
                source.start(0);
                // Attendi un breve istante e ricontrolla
                await new Promise(resolve => setTimeout(resolve, 50));
                 if (audioContext.state === 'running') {
                    console.log('AudioContext running after silent sound workaround.');
                    audioContextUnlocked = true;
                    return true;
                } else {
                     console.warn('AudioContext still not running after silent sound. State:', audioContext.state);
                     return false;
                }
            }
        } catch (e) {
            console.error('Error resuming AudioContext:', e);
            return false;
        }
    } else if (audioContext.state === 'running') {
        audioContextUnlocked = true;
        return true;
    }
    return false; // Stato sconosciuto o già fallito
}

async function initializeAudioProcessing() {
    updateUI('initializing', 'Avvio...', 'icon-mic', 'Inizializzazione audio...');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
        controlButton.disabled = true;
        return false;
    }

    const audioUnlocked = await unlockAudioContextIfNeeded();
    if (!audioUnlocked && (!audioContext || audioContext.state !== 'running')) {
        // Se non si sblocca, potrebbe essere problematico ma proviamo comunque getUserMedia.
        // Alcuni browser potrebbero sbloccare l'AudioContext implicitamente con getUserMedia.
        console.warn("AudioContext non è stato sbloccato completamente prima di getUserMedia.");
    }

    try {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Se AudioContext è stato creato ma non ancora sbloccato,
        // getUserMedia a volte aiuta, quindi ricontrolliamo/riproviamo lo sblocco.
        if (audioContext && !audioContextUnlocked) {
             console.log("Ritentativo sblocco AudioContext dopo getUserMedia.");
             await unlockAudioContextIfNeeded();
        }
        if (!audioContext || audioContext.state !== 'running') {
            // Questo è un problema più serio se ancora non è 'running'
            console.error("AudioContext non è 'running' neanche dopo getUserMedia e tentativi di sblocco.");
            // updateUI('idle', 'Errore Audio', 'icon-mic', 'AudioContext non attivo.');
            // return false; // Non blocchiamo qui, MediaRecorder potrebbe funzionare lo stesso per la registrazione
        }


        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        microphoneSource = audioContext.createMediaStreamSource(globalStream);
        microphoneSource.connect(analyser);

        // Selezione MIME Type per Registrazione
        // Priorità: WebM/Opus, poi MP4/AAC (o M4A)
        const mimeTypesToTry = [
            'audio/webm;codecs=opus',
            'audio/mp4', // Lascia che il browser scelga il codec (prob. AAC)
            'audio/m4a', // Alternativa per AAC su Apple
            'audio/ogg;codecs=opus',
            'audio/wav' // Ultima risorsa, per la massima compatibilità di decodifica
        ];
        let preferredMimeType = '';
        for (const mime of mimeTypesToTry) {
            if (MediaRecorder.isTypeSupported(mime)) {
                preferredMimeType = mime;
                console.log(`MediaRecorder: Useremo il MIME type preferito: ${preferredMimeType}`);
                break;
            }
            console.log(`MediaRecorder: ${mime} non supportato.`);
        }

        if (!preferredMimeType) {
            console.warn("Nessun MIME type preferito supportato esplicitamente. Si userà il default del browser (se esiste).");
            // Lasciando preferredMimeType vuoto, MediaRecorder userà il suo default.
        }
        recordingMimeType = preferredMimeType; // Imposta la preferenza, sarà verificata in startVAD

        return true;
    } catch (err) {
        console.error('Errore getUserMedia o AudioContext setup:', err);
        let msg = 'Errore microfono.';
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') msg = 'Permesso microfono negato.';
        else if (err.name === 'NotFoundError') msg = 'Nessun microfono trovato.';
        updateUI('idle', 'Errore Mic.', 'icon-mic', msg);
        return false;
    }
}

function stopAndReleaseMediaRecorder() {
    if (mediaRecorderForVAD) {
        if (mediaRecorderForVAD.state === "recording") {
            try { mediaRecorderForVAD.stop(); } catch (e) { console.warn("Errore stop MediaRecorder:", e); }
        }
        mediaRecorderForVAD.ondataavailable = null;
        mediaRecorderForVAD.onstart = null;
        mediaRecorderForVAD.onstop = null;
        mediaRecorderForVAD.onerror = null;
        mediaRecorderForVAD = null;
    }
}

function startVAD() {
    if (!audioContext || !analyser || !globalStream || !microphoneSource) {
        cleanUpFullSession();
        return;
    }
    // Assicurati che l'AudioContext sia attivo per l'analyser
    if (audioContext.state === 'suspended') {
        console.warn("startVAD: AudioContext sospeso, tentativo di ripresa per Analyser.");
        audioContext.resume().then(() => proceedWithVadStart()).catch(() => proceedWithVadStart());
    } else {
        proceedWithVadStart();
    }
}

function proceedWithVadStart() {
    stopAndReleaseMediaRecorder();
    updateUI('listening_continuous', 'Termina Conversazione', 'icon-stop', 'Ascolto...');
    speaking = false;
    silenceStartTime = performance.now();
    currentTurnAudioChunks = [];

    const options = recordingMimeType ? { mimeType: recordingMimeType } : {};
    try {
        mediaRecorderForVAD = new MediaRecorder(globalStream, options);
        // Verifica il MIME type effettivo
        if (mediaRecorderForVAD.mimeType) {
            if (recordingMimeType && mediaRecorderForVAD.mimeType !== recordingMimeType) {
                console.warn(`MediaRecorder userà: "${mediaRecorderForVAD.mimeType}" invece di "${recordingMimeType}".`);
            }
            recordingMimeType = mediaRecorderForVAD.mimeType; // Aggiorna al MIME type effettivo!
        } else if (recordingMimeType) {
            console.warn(`MediaRecorder non ha un mimeType effettivo, si assume: "${recordingMimeType}".`);
        } else {
            console.error("Critico: MediaRecorder non ha un mimeType e non ne è stato richiesto uno. La registrazione potrebbe avere un formato sconosciuto.");
            recordingMimeType = 'application/octet-stream'; // Fallback estremo
        }
        console.log("MediaRecorder creato. MIME type effettivo usato: ", recordingMimeType);

    } catch (e) {
        console.error("Errore creazione MediaRecorder:", e, "Opzioni:", options);
        cleanUpFullSession();
        updateUI('idle', 'Errore Registratore', 'icon-mic', 'Formato audio non supportato.');
        return;
    }

    mediaRecorderForVAD.ondataavailable = event => {
        if (event.data.size > 0) currentTurnAudioChunks.push(event.data);
    };
    mediaRecorderForVAD.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        updateUI('idle', 'Errore Registrazione', 'icon-mic', 'Errore registrazione.');
        stopAndReleaseMediaRecorder(); // Non pulire tutta la sessione, solo il recorder
    };
    mediaRecorderForVAD.onstop = () => {
        console.log("MediaRecorder.onstop. Chunks:", currentTurnAudioChunks.length);
    };

    try {
        mediaRecorderForVAD.start(500); // Raccogli chunk
    } catch (e) {
        console.error("Errore mediaRecorder.start():", e);
        cleanUpFullSession();
        return;
    }

    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    processAudioLoop();
}

function cleanUpFullSession(resetAudioCtx = false) {
    if (vadProcessTimeout) cancelAnimationFrame(vadProcessTimeout);
    vadProcessTimeout = null;
    stopAndReleaseMediaRecorder();
    
    if (microphoneSource) microphoneSource.disconnect();
    microphoneSource = null;
    analyser = null; 

    if (resetAudioCtx && audioContext && audioContext.state !== 'closed') {
        audioContext.close().catch(e => console.warn("Errore chiusura AudioContext:", e));
        audioContext = null;
        audioContextUnlocked = false;
    }

    if (globalStream) globalStream.getTracks().forEach(track => track.stop());
    globalStream = null;
    conversationHistory = [];
    currentTurnAudioChunks = [];
    speaking = false;

    if (currentAudio) {
        currentAudio.pause();
        if (fernandaAudioUrlToPlay) URL.revokeObjectURL(fernandaAudioUrlToPlay); // Pulisci URL se c'era
        fernandaAudioUrlToPlay = null;
        currentAudio.src = ""; // Per Safari
        currentAudio.load(); // Per Safari
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio = null;
    }
    isFernandaSpeaking = false;
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}

function processAudioLoop() {
    if (currentConversationState !== 'listening_continuous' || !analyser || !mediaRecorderForVAD) {
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
        if (speaking && (currentTime - silenceStartTime > VAD_SILENCE_DURATION_MS)) {
            speaking = false;
            const speechDuration = currentTime - speechStartTime - VAD_SILENCE_DURATION_MS;
            if (speechDuration > VAD_SPEECH_MIN_DURATION_MS && currentTurnAudioChunks.length > 0) {
                const chunksToSend = [...currentTurnAudioChunks];
                currentTurnAudioChunks = [];
                const actualBlobMimeType = recordingMimeType || 'application/octet-stream';
                const audioBlob = new Blob(chunksToSend, { type: actualBlobMimeType });
                const fileExtension = getExtensionFromMimeType(actualBlobMimeType);
                const filenameForApi = `${baseRecordingFilename}${fileExtension}`;
                console.log(`Invio audio: ${filenameForApi}, Type: ${actualBlobMimeType}, Size: ${audioBlob.size}`);
                sendAudioForTranscription(audioBlob, filenameForApi);
                return; // Esci dal loop VAD, sendAudio gestirà il flusso
            } else {
                currentTurnAudioChunks = []; // Parlato troppo breve
            }
        } else if (!speaking) {
            silenceStartTime = currentTime;
        }
    }
    vadProcessTimeout = requestAnimationFrame(processAudioLoop);
}

async function sendAudioForTranscription(audioBlob, filename) {
    if (audioBlob.size === 0) {
        resumeListeningAfterFernanda(); return;
    }
    updateUI('processing_vad_chunk', 'Termina Conversazione', 'icon-thinking', 'Trascrivo...');
    const formData = new FormData();
    formData.append('audio', audioBlob, filename);

    try {
        const transcribeResponse = await fetch('/api/transcribe', { method: 'POST', body: formData });
        if (!transcribeResponse.ok) {
            const errData = await transcribeResponse.json().catch(() => ({ error: `Trascrizione: ${transcribeResponse.status}` }));
            throw new Error(errData.error || `Errore Trascrizione ${transcribeResponse.status}`);
        }
        const { transcript } = await transcribeResponse.json();
        if (!transcript || transcript.trim().length < 2) {
            statusMessage.textContent = 'Non ho capito. Ripeti.';
            setTimeout(resumeListeningAfterFernanda, 1000); return;
        }
        conversationHistory.push({ role: 'user', content: transcript });
        await processChatWithFernanda(transcript);
    } catch (error) {
        console.error('Errore trascrizione:', error);
        statusMessage.textContent = `Errore: ${error.message}. Riprova.`;
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
            const errData = await chatResponse.json().catch(() => ({ error: "Errore API Chat" }));
            throw new Error(errData.error || `Errore Chat ${chatResponse.status}`);
        }
        const { reply } = await chatResponse.json();
        conversationHistory.push({ role: 'assistant', content: reply });
        if (conversationHistory.length > 20) conversationHistory.splice(0, conversationHistory.length - 20); // Limita cronologia

        const ttsResponse = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: reply })
        });
        if (!ttsResponse.ok) {
            const errData = await ttsResponse.json().catch(() => ({ error: "Errore API TTS" }));
            throw new Error(errData.error || `Errore TTS ${ttsResponse.status}`);
        }
        const audioFernandaBlob = await ttsResponse.blob();
        if (fernandaAudioUrlToPlay) URL.revokeObjectURL(fernandaAudioUrlToPlay); // Pulisci vecchio URL
        fernandaAudioUrlToPlay = URL.createObjectURL(audioFernandaBlob);
        await playFernandaAudio();
    } catch (error) {
        console.error('Errore chat/tts:', error);
        statusMessage.textContent = `Oops: ${error.message}. Riprova.`;
        setTimeout(resumeListeningAfterFernanda, 1500);
    }
}

async function playFernandaAudio() {
    if (!fernandaAudioUrlToPlay) {
        console.warn("Nessun URL audio di Fernanda da riprodurre.");
        resumeListeningAfterFernanda();
        return;
    }

    if (currentAudio) { // Pulisci l'eventuale audio precedente
        currentAudio.pause();
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.src = ""; // Per Safari
        currentAudio.load(); // Per Safari
    }
    currentAudio = new Audio(fernandaAudioUrlToPlay);
    isFernandaSpeaking = true;
    updateUI('fernanda_speaking_continuous', 'Interrompi Fernanda', 'icon-stop', 'Fernanda parla...');

    currentAudio.onended = () => {
        isFernandaSpeaking = false;
        URL.revokeObjectURL(fernandaAudioUrlToPlay); // Pulisci URL dopo riproduzione
        fernandaAudioUrlToPlay = null;
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous') { // Solo se non interrotta o con errore
            resumeListeningAfterFernanda();
        }
    };
    currentAudio.onerror = (e) => {
        console.error("Errore riproduzione audio Fernanda:", e, currentAudio.error);
        isFernandaSpeaking = false;
        if (fernandaAudioUrlToPlay) URL.revokeObjectURL(fernandaAudioUrlToPlay);
        fernandaAudioUrlToPlay = null;
        currentAudio = null;
        if (currentConversationState === 'fernanda_speaking_continuous' || currentConversationState === 'awaiting_play_permission') {
            statusMessage.textContent = 'Problema audio. Riprova.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    };

    try {
        // Assicurati che l'AudioContext sia attivo per una maggiore probabilità di successo dell'autoplay
        if (audioContext && audioContext.state === 'suspended') await audioContext.resume();
        await currentAudio.play();
        console.log("Audio Fernanda: tentativo autoplay riuscito.");
    } catch (error) {
        console.warn("Audio Fernanda: autoplay fallito:", error.name, error.message);
        isFernandaSpeaking = false; // Non sta parlando se play fallisce
        if (error.name === 'NotAllowedError') {
            updateUI('awaiting_play_permission', 'Ascolta Fernanda', 'icon-play', 'Audio bloccato. Tocca per ascoltare.');
            // L'URL (fernandaAudioUrlToPlay) è ancora valido, l'utente cliccherà
        } else {
            // Altro errore, pulisci e torna ad ascoltare
            if (fernandaAudioUrlToPlay) URL.revokeObjectURL(fernandaAudioUrlToPlay);
            fernandaAudioUrlToPlay = null;
            currentAudio = null;
            statusMessage.textContent = 'Errore riproduzione. Riprova.';
            setTimeout(resumeListeningAfterFernanda, 1000);
        }
    }
}

function resumeListeningAfterFernanda() {
    if (currentConversationState === 'idle' || !globalStream) {
        if (currentConversationState !== 'idle') cleanUpFullSession();
        return;
    }
    if (currentConversationState === 'awaiting_play_permission') return; // Non riprendere se in attesa di click

    // Breve ritardo per stabilizzazione
    setTimeout(() => {
        if (globalStream && audioContext && analyser && microphoneSource) {
            startVAD();
        } else {
            cleanUpFullSession();
        }
    }, 100);
}

async function handleControlButtonClick() {
    const audioUnlocked = await unlockAudioContextIfNeeded(); // Sblocca/Crea AudioContext al primo click
    if (!audioUnlocked && (!audioContext || audioContext.state !== 'running') && currentConversationState === 'idle') {
        console.warn("AudioContext non completamente sbloccato, l'esperienza potrebbe essere degradata.");
        // Non bloccare l'avvio, ma segnala.
    }


    switch (currentConversationState) {
        case 'idle':
            const ready = await initializeAudioProcessing();
            if (ready) startVAD();
            else updateUI('idle', 'Errore Init', 'icon-mic', 'Inizializzazione fallita.'); // Assicura che l'UI sia corretta
            break;
        case 'listening_continuous':
        case 'processing_vad_chunk':
            cleanUpFullSession();
            break;
        case 'fernanda_speaking_continuous':
            if (currentAudio) currentAudio.pause(); // onended gestirà il resto
            isFernandaSpeaking = false; // Per sicurezza
            resumeListeningAfterFernanda(); // Torna ad ascoltare
            break;
        case 'awaiting_play_permission':
            if (fernandaAudioUrlToPlay) {
                console.log("Click per riprodurre audio di Fernanda (precedentemente bloccato).");
                await playFernandaAudio(); // Riprova a riprodurre l'URL memorizzato
            } else {
                console.warn("Click in awaiting_play_permission, ma fernandaAudioUrlToPlay è nullo.");
                resumeListeningAfterFernanda(); // Fallback
            }
            break;
        default: cleanUpFullSession();
    }
}

controlButton.addEventListener('click', handleControlButtonClick);

// Setup iniziale
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateUI('idle', 'Non Supportato', 'icon-mic', 'Audio/Mic non supportato.');
    controlButton.disabled = true;
} else {
    updateUI('idle', 'Avvia Conversazione', 'icon-mic', 'Pronta quando vuoi.');
}
