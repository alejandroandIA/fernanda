const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;
let currentAudio = null; // Per tenere traccia dell'audio in riproduzione

// Verifica se il browser supporta SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT'; // Lingua italiana
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    startButton.onclick = () => {
        // Se c'è un audio in riproduzione, fermalo prima di iniziare un nuovo ascolto
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0; // Resetta l'audio
            // Non è necessario revocare l'URL qui se l'utente interrompe
        }
        try {
            statusDiv.textContent = 'In ascolto... parla pure!';
            recognition.start();
            startButton.disabled = true;
            startButton.textContent = "Sto ascoltando...";
        } catch (error) {
            console.error("Errore all'avvio del riconoscimento:", error);
            statusDiv.textContent = 'Errore: non posso iniziare l\'ascolto ora. Riprova.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onresult = async (event) => {
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI...';
        startButton.disabled = true;
        startButton.textContent = "Elaboro...";

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ userMessage: speechResult }),
            });

            if (!response.ok) {
                let errorDetails = 'Errore API chat sconosciuto';
                try {
                    const errorData = await response.json();
                    errorDetails = errorData.error || (errorData.details ? JSON.stringify(errorData.details) : response.statusText);
                } catch (e) {
                    errorDetails = response.statusText;
                }
                throw new Error(`Errore dalla API Chat: ${errorDetails} (Status: ${response.status})`);
            }

            const data = await response.json();
            const aiResponse = data.reply;

            if (aiResponse) {
                addMessageToChat('AI: ' + aiResponse, 'assistant');
                speak(aiResponse); // Chiama la funzione per la sintesi vocale
            } else {
                addMessageToChat('AI: Non ho ricevuto una risposta valida da OpenAI.', 'assistant');
                statusDiv.textContent = 'Problema con la risposta. Premi "Parla" per riprovare.';
                startButton.disabled = false;
                startButton.textContent = "🎤 Parla";
            }

        } catch (error) {
            console.error('Errore nella chiamata API chat o nella gestione della risposta:', error);
            addMessageToChat('AI: Spiacente, c\'è stato un errore (chat): ' + error.message, 'assistant');
            statusDiv.textContent = 'Errore. Premi "Parla" per riprovare.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
        }
        // startButton.disabled = false; // Lo stato del bottone è gestito da speak() o qui in caso di errore
        // startButton.textContent = "🎤 Parla";
    };

    recognition.onspeechend = () => {
        recognition.stop();
        // Lo stato verrà aggiornato da onresult, onerror, o dalla funzione speak()
    };

    recognition.onnomatch = () => {
        statusDiv.textContent = "Non ho capito. Prova a parlare più chiaramente.";
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
    };

    recognition.onerror = (event) => {
        let errorMessage = 'Errore nel riconoscimento: ' + event.error;
        if (event.error === 'no-speech') {
            errorMessage = 'Non ho sentito nulla. Assicurati che il microfono sia attivo e che tu abbia dato i permessi.';
        } else if (event.error === 'audio-capture') {
            errorMessage = 'Problema con il microfono. Controlla i permessi e che non sia usato da altre app.';
        } else if (event.error === 'not-allowed' || event.error === 'aborted') {
            errorMessage = 'Permesso di usare il microfono negato o ascolto interrotto. Abilitalo nelle impostazioni del browser per questo sito.';
        }
        statusDiv.textContent = errorMessage;
        console.error("SpeechRecognition Error:", event);
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
    };

} else {
    startButton.disabled = true;
    statusDiv.textContent = "Il tuo browser non supporta il riconoscimento vocale.";
    alert("Il tuo browser non supporta l'API Web Speech. Prova con Chrome o Edge aggiornati.");
}

function addMessageToChat(message, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);
    messageElement.textContent = message;
    outputDiv.appendChild(messageElement);
    outputDiv.scrollTop = outputDiv.scrollHeight;
}

// --- Inizio sezione per la SINTESI VOCALE (TTS) di OpenAI ---
async function speak(textToSpeak) {
    if (!textToSpeak) {
        startButton.disabled = false; // Riabilita se non c'è testo da dire
        startButton.textContent = "🎤 Parla";
        return;
    }
    statusDiv.textContent = "L'AI sta parlando...";
    startButton.disabled = true; // Disabilita il pulsante "Parla" mentre l'AI parla
    startButton.textContent = "Attendere...";


    try {
        const response = await fetch('/api/tts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: textToSpeak }),
        });

        if (!response.ok) {
            let errorDetails = 'Errore nella generazione audio';
            try {
                const errorData = await response.json();
                errorDetails = errorData.error?.message || JSON.stringify(errorData.details) || 'Dettagli errore non disponibili';
            } catch (e) {
                errorDetails = response.statusText;
            }
            throw new Error(`${errorDetails} (Status: ${response.status})`);
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        
        if (currentAudio) { // Se c'era un audio precedente, assicurati che sia fermo
            currentAudio.pause();
        }
        currentAudio = new Audio(audioUrl); // Assegna il nuovo audio
        
        currentAudio.play().catch(e => {
            console.error("Errore durante la riproduzione dell'audio:", e);
            statusDiv.textContent = 'Errore nella riproduzione audio.';
            addMessageToChat('AI (audio play error): ' + e.message, 'assistant');
            // Non riabilitare il pulsante qui, lo farà onended o onerror
        });

        currentAudio.onended = () => {
            statusDiv.textContent = 'Premi "Parla" per continuare.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
            URL.revokeObjectURL(audioUrl);
            currentAudio = null; // Resetta l'audio corrente
        };

        currentAudio.onerror = (e) => {
            console.error('Errore elemento Audio:', e);
            statusDiv.textContent = 'Errore durante il caricamento/riproduzione dell\'audio.';
            startButton.disabled = false;
            startButton.textContent = "🎤 Parla";
            URL.revokeObjectURL(audioUrl);
            addMessageToChat('AI (audio load/play error): Errore audio.', 'assistant');
            currentAudio = null;
        };

    } catch (error) {
        console.error('Errore nella sintesi vocale (chiamata a /api/tts):', error);
        statusDiv.textContent = 'Errore nella generazione audio.';
        startButton.disabled = false;
        startButton.textContent = "🎤 Parla";
        addMessageToChat('AI (TTS API error): ' + error.message, 'assistant');
        if (currentAudio) { // Assicurati che l'URL venga revocato anche in caso di errore API TTS
            URL.revokeObjectURL(currentAudio.src); // currentAudio.src dovrebbe contenere l'audioUrl
            currentAudio = null;
        }
    }
}
// --- Fine sezione per la SINTESI VOCALE ---
