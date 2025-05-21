// api/tts.js
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Text is required for TTS' });
  }

  if (!process.env.OPENAI_API_KEY_FERNANDA) {
    console.error('OPENAI_API_KEY_FERNANDA not configured for TTS');
    return res.status(500).json({ error: 'Server configuration error: OpenAI API key missing for TTS.' });
  }

  try {
    const mp3Stream = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova", // Prova "nova" o "shimmer" per voci femminili chiare
      input: text,
      response_format: "mp3", 
      speed: 1.0 // Velocità normale
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    
    // Pipe lo stream ReadableStream (mp3Stream.body) direttamente alla risposta
    // Vercel gestisce questo in modo efficiente per le funzioni serverless
    if (mp3Stream.body && typeof mp3Stream.body.pipe === 'function') {
        mp3Stream.body.pipe(res);
        // Non chiamare res.end() o res.send(), pipe lo farà.
        // Aggiungiamo un listener per errore sullo stream sorgente
        mp3Stream.body.on('error', (streamError) => {
            console.error("Errore nello stream audio sorgente:", streamError);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Errore durante lo streaming dell\'audio.' });
            }
            res.end(); // Assicura che la risposta sia terminata
        });
    } else {
        // Fallback se .body non è uno stream (improbabile con la versione SDK attuale)
        console.error("Il corpo della risposta TTS non è uno stream pipable.");
        const buffer = Buffer.from(await mp3Stream.arrayBuffer());
        res.send(buffer);
    }

  } catch (error) {
    console.error('OpenAI API Error (TTS):', error.response ? error.response.data : error.message);
    let userErrorMessage = 'Errore nel contattare il servizio AI (TTS).';
     if (error.status === 401) {
        userErrorMessage = 'Errore di autenticazione con il servizio AI (TTS). Controlla la chiave API.';
    } else if (error.status === 400 && error.message.includes("input text is too long")) {
        userErrorMessage = 'Il testo da convertire in voce è troppo lungo.';
    } else if (error.status === 429) {
        userErrorMessage = 'Hai superato i limiti di richieste al servizio AI (TTS). Riprova più tardi.';
    }
    // Assicurati di non inviare una risposta se gli header sono già stati inviati (es. da pipe)
    if (!res.headersSent) {
      res.status(500).json({ error: userErrorMessage });
    } else {
      // Se gli header sono inviati ma c'è un errore dopo (es. durante il piping),
      // possiamo solo chiudere la connessione. Il client potrebbe ricevere un file audio incompleto.
      res.end();
    }
  }
}
