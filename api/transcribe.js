// api/transcribe.js
import OpenAI from 'openai';
import formidable from 'formidable'; // Per gestire l'upload di file (audio)
import fs from 'fs'; // File system per leggere e rinominare il file temporaneo

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

  const form = formidable({ multiples: false }); // multiples: false per assicurarci un solo file per campo
  let tempFilePathForCleanupOnError = null; // Percorso per pulizia in caso di errore

  try {
    const [fields, files] = await form.parse(req);
    
    const audioFileArray = files.audio; // 'audio' è il nome del campo che invieremo dal frontend

    if (!audioFileArray || audioFileArray.length === 0) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }

    const uploadedFile = audioFileArray[0]; // formidable v3 restituisce un array anche per un singolo file
    const tempFilePath = uploadedFile.filepath; // Percorso del file temporaneo di formidable
    tempFilePathForCleanupOnError = tempFilePath; // Salva per pulizia in caso di errore prima del rename
    
    // Determina l'estensione corretta dal nome originale o default a 'webm'
    const originalFilename = uploadedFile.originalFilename || 'audio.webm';
    const fileExtension = (originalFilename.includes('.') ? originalFilename.split('.').pop() : 'webm') || 'webm';
    
    const newPathWithExtension = `${tempFilePath}.${fileExtension}`;
    tempFilePathForCleanupOnError = newPathWithExtension; // Aggiorna il percorso per la pulizia

    console.log('--- Transcribe API Debug ---');
    console.log('Original filename from client:', originalFilename);
    console.log('Mimetype from formidable:', uploadedFile.mimetype);
    console.log('Temporary file path from formidable:', tempFilePath);
    console.log('New path with extension for OpenAI:', newPathWithExtension);
    console.log('-----------------------------');

    // Verifica se il file temporaneo esiste prima di rinominare
    if (!fs.existsSync(tempFilePath)) {
        console.error("CRITICAL ERROR: Temporary file does not exist before rename:", tempFilePath);
        return res.status(500).json({ error: 'Server internal error: temporary file not found.' });
    }

    fs.renameSync(tempFilePath, newPathWithExtension);
    console.log('Renamed temporary file to:', newPathWithExtension);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newPathWithExtension), // Usa il file rinominato
      model: "whisper-1",
      language: "it",
      response_format: "json",
    });

    console.log('Transcription result:', transcription.text);

    // Pulisci il file rinominato dopo l'uso
    fs.unlink(newPathWithExtension, err => {
      if (err) console.error("Error deleting renamed temp file after success:", err);
      else console.log("Successfully deleted renamed temp file:", newPathWithExtension);
    });
    tempFilePathForCleanupOnError = null; // Resetta perché la pulizia è andata a buon fine

    res.status(200).json({ transcript: transcription.text });

  } catch (error) {
    console.error('Error during transcription process:', error);
    
    // Tenta di pulire il file temporaneo (rinominato o originale) se esiste ancora
    if (tempFilePathForCleanupOnError && fs.existsSync(tempFilePathForCleanupOnError)) {
      fs.unlink(tempFilePathForCleanupOnError, unlinkErr => {
        if (unlinkErr) console.error("Error deleting temp file during error handling:", unlinkErr);
        else console.log("Successfully deleted temp file during error handling:", tempFilePathForCleanupOnError);
      });
    }

    let userErrorMessage = 'Errore durante la trascrizione audio.';
    if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
        console.error('OpenAI API Error (transcribe):', error.response.data.error.message);
        userErrorMessage = error.response.data.error.message;
    } else if (error.message) {
        userErrorMessage = error.message;
    }
    
    // Lo status code di OpenAI viene propagato se presente, altrimenti 500
    const statusCode = error.status || (error.response ? error.response.status : 500);
    res.status(statusCode).json({ error: userErrorMessage });
  }
}
