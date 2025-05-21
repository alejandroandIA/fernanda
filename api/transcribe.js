// api/transcribe.js
import OpenAI from 'openai';
import formidable from 'formidable';
import fs from 'fs';

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
    console.error('OPENAI_API_KEY_FERNANDA not configured');
    return res.status(500).json({ error: 'Server config error: OpenAI API key missing.' });
  }

  const form = formidable({ multiples: false });
  let tempFilePathForCleanup = null;

  try {
    const [fields, files] = await form.parse(req);
    const audioFileArray = files.audio;

    if (!audioFileArray || audioFileArray.length === 0) {
      return res.status(400).json({ error: 'No audio file uploaded.' });
    }

    const uploadedFile = audioFileArray[0];
    tempFilePathForCleanup = uploadedFile.filepath;
    const originalFilename = uploadedFile.originalFilename || 'audio.unknown'; // Nome file dal client

    console.log('--- Transcribe API (Simplified Debug) ---');
    console.log('Received file. Original Filename:', originalFilename);
    console.log('Mimetype from formidable:', uploadedFile.mimetype);
    console.log('Temporary file path:', tempFilePathForCleanup);
    console.log('File size:', uploadedFile.size);
    console.log('---------------------------------------');
    
    if (uploadedFile.size === 0) {
        console.error("Uploaded file is empty.");
        fs.unlink(tempFilePathForCleanup, () => {}); // Pulisci file vuoto
        return res.status(400).json({ error: 'Audio file is empty.' });
    }
    
    // Passiamo direttamente lo stream del file temporaneo.
    // La libreria OpenAI v4 dovrebbe gestire lo stream e usare
    // le informazioni del file (come il nome originale se passato correttamente)
    // o il contenuto per inferire il tipo.
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePathForCleanup), // Lo stream
      model: "whisper-1",
      language: "it",
      response_format: "json",
      // Se il nome del file fosse critico, potremmo dover costruire un oggetto File-like
      // ma per ora proviamo così, affidandoci alla libreria.
    });

    console.log('Whisper Transcription successful:', transcription.text);
    
    fs.unlink(tempFilePathForCleanup, err => {
      if (err) console.error("Error deleting temp file after success:", err);
    });
    tempFilePathForCleanup = null;

    res.status(200).json({ transcript: transcription.text });

  } catch (error) {
    if (tempFilePathForCleanup && fs.existsSync(tempFilePathForCleanup)) {
      fs.unlink(tempFilePathForCleanup, () => {});
    }
    console.error('Error in /api/transcribe:', error);
    let userErrorMessage = 'Errore durante la trascrizione.';
    let statusCode = 500;

    if (error.response && error.response.data && error.response.data.error) {
        console.error('OpenAI API Error Data:', error.response.data.error);
        userErrorMessage = error.response.data.error.message || userErrorMessage;
        statusCode = error.response.status || statusCode;
    } else if (error.message) {
        userErrorMessage = error.message;
        if (error.status) statusCode = error.status;
    }
    res.status(statusCode).json({ error: userErrorMessage });
  }
}
