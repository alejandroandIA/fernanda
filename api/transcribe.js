// api/transcribe.js
import OpenAI from 'openai';
import formidable from 'formidable'; // Per gestire l'upload di file (audio)
import fs from 'fs'; // File system per leggere il file temporaneo

// Disabilita il bodyParser predefinito di Vercel/Next.js per questo endpoint,
// perché formidable gestirà il parsing del corpo della richiesta multipart/form-data.
export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY_FERNANDA,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!process.env.OPENAI_API_KEY_FERNANDA) {
    console.error('OPENAI_API_KEY_FERNANDA not configured for transcribe');
    return res.status(500).json({ error: 'Server configuration error: OpenAI API key missing for transcription.' });
  }

  const form = formidable({}); // Usa opzioni predefinite

  try {
    const [fields, files] = await form.parse(req);
    
    const audioFile = files.audio; // 'audio' è il nome del campo che invieremo dal frontend

    if (!audioFile || audioFile.length === 0) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }

    // formidable salva il file caricato in un percorso temporaneo.
    // Dobbiamo accedere al primo file se ce ne sono multipli con lo stesso nome (improbabile qui)
    const uploadedFile = Array.isArray(audioFile) ? audioFile[0] : audioFile;
    const filePath = uploadedFile.filepath;
    const originalFilename = uploadedFile.originalFilename || 'audio.webm'; // Fornisci un nome file con estensione

    console.log('Audio file received on server, path:', filePath, 'original filename:', originalFilename);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath), // Crea uno stream leggibile dal file temporaneo
      model: "whisper-1",
      language: "it", // Specifica la lingua per migliorare l'accuratezza
      response_format: "json", // o "text" se preferisci solo il testo
      // temperature: 0, // Opzionale: per trascrizioni più deterministiche
    });

    console.log('Transcription result:', transcription);

    // Pulisci il file temporaneo dopo l'uso (opzionale, Vercel dovrebbe farlo, ma buona pratica)
    fs.unlink(filePath, err => {
      if (err) console.error("Error deleting temp file:", err);
    });

    res.status(200).json({ transcript: transcription.text });

  } catch (error) {
    console.error('Error during transcription process:', error);
    let userErrorMessage = 'Errore durante la trascrizione audio.';
    if (error.response && error.response.data) { // Errore specifico da OpenAI API
        console.error('OpenAI API Error (transcribe):', error.response.data);
        userErrorMessage = error.response.data.error?.message || userErrorMessage;
    } else if (error.message) {
        userErrorMessage = error.message;
    }
    
    // Se l'errore è da formidable o file system prima della chiamata OpenAI
    if (error.status) {
         return res.status(error.status).json({ error: userErrorMessage });
    }
    res.status(500).json({ error: userErrorMessage });
  }
}
