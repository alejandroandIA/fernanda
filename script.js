const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const outputDiv = document.getElementById('output');
let recognition;

// Verifica se il browser supporta SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognitionAPI();
    recognition.lang = 'it-IT'; // Lingua italiana
    recognition.interimResults = false; // Vogliamo solo risultati finali
    recognition.maxAlternatives = 1; // Solo la trascrizione più probabile

    startButton.onclick = () => {
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

    recognition.onresult = async (event) => { // Aggiunto async per await
        const speechResult = event.results[0][0].transcript;
        addMessageToChat('Tu: ' + speechResult, 'user');
        statusDiv.textContent = 'Trascritto: "' + speechResult + '". Invio a OpenAI...';
        startButton.disabled = true; // Mantieni disabilitato mentre si attende OpenAI
        startButton.textContent = "Elaboro...";

        try {
            const response = await fetch('/api/chat', { // Chiama la nostra funzione serverless
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ userMessage: speechResult }),
            });

            if (!response.ok) {
                // Prova a leggere l'errore come JSON, altrimenti usa il testo dello stato
                let errorDetails = 'Errore API sconosciuto';
                try {
                    const errorData = await response.json();
                    errorDetails = errorData.error || (errorData.details ? JSON.stringify(errorData.details) : response.statusText);
                } catch (e) {
                    errorDetails = response.statusText;
                }
                throw new Error(`Errore dalla API: ${errorDetails} (Status: ${response.status})`);
            }

            const data = await response.json();
            const aiResponse = data.reply;

            if (aiResponse) {
                addMessageToChat('AI: ' + aiResponse, 'assistant');
                statusDiv.textContent = 'Premi "Parla" per continuare.';
                // Prossimo passo: riprodurre aiResponse come audio
                // speak(aiResponse); // DA IMPLEMENTARE
            } else {
                addMessageToChat('AI: Non ho ricevuto una risposta valida da OpenAI.', 'assistant');
                statusDiv.textContent = 'Problema con la risposta. Premi "Parla" per riprovare.';
            }

        } catch (error) {
            console.error('Errore nella chiamata API o nella gestione della risposta:', error);
            addMessageToChat('AI: Spiacente, c\'è stato un errore: ' + error.message, 'assistant');
            statusDiv.textContent = 'Errore. Premi "Parla" per riprovare.';
        } finally {
            startButton.disabled = false; // Riabilita sempre il pulsante alla fine
            startButton.textContent = "🎤 Parla";
        }
    };

    recognition.onspeechend = () => {
        recognition.stop();
        // Lo stato verrà aggiornato da onresult o onerror
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
        } else if (event.error === 'not-allowed') {
            errorMessage = 'Permesso di usare il microfono negato o scaduto. Abilitalo nelle impostazioni del browser per questo sito.';
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
    // Scrolla in fondo per vedere l'ultimo messaggio
    outputDiv.scrollTop = outputDiv.scrollHeight;
}

// --- Inizio sezione per la SINTESI VOCALE (TTS) di OpenAI ---
// La implementeremo nel prossimo passo.

// async function speak(textToSpeak) {
//     if (!textToSpeak) return;
//     statusDiv.textContent = "L'AI sta parlando...";
//     startButton.disabled = true; // Disabilita il pulsante mentre l'AI parla

//     try {
//         const response = await fetch('/api/tts', { // Creeremo questa nuova API endpoint
//             method: 'POST',
//             headers: {
//                 'Content-Type': 'application/json',
//             },
//             body: JSON.stringify({ text: textToSpeak }),
//         });

//         if (!response.ok) {
//             const errorData = await response.json();
//             throw new Error(errorData.error || 'Errore nella generazione audio');
//         }

//         const audioBlob = await response.blob();
//         const audioUrl = URL.createObjectURL(audioBlob);
//         const audio = new Audio(audioUrl);
//         audio.play();

//         audio.onended = () => {
//             statusDiv.textContent = 'Premi "Parla" per continuare.';
//             startButton.disabled = false;
//             URL.revokeObjectURL(audioUrl); // Libera la memoria
//         };

//     } catch (error) {
//         console.error('Errore nella sintesi vocale:', error);
//         statusDiv.textContent = 'Errore nella riproduzione audio. Premi "Parla".';
//         startButton.disabled = false;
//         addMessageToChat('AI (audio error): ' + error.message, 'assistant');
//     }
// }
// --- Fine sezione per la SINTESI VOCALE ---
