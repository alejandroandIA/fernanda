// api/transcribe.js
import OpenAI from 'openai';
import formidable from 'formidable';
import fs from 'fs';
import { toFile } from 'openai/uploads'; // Importa toFile

export const config = {
  api: {
    bodyParser: false, // Necessario perché formidable gestisce il parsing del corpo
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
    
    // originalFilename viene dal client (frontend) e dovrebbe avere l'estensione corretta grazie alle modifiche nel frontend.
    const originalFilename = uploadedFile.originalFilename || 'audio.unknown'; 

    console.log('--- Transcribe API ---');
    console.log('Original Filename from client:', originalFilename);
    console.log('Mimetype detected by formidable:', uploadedFile.mimetype);
    console.log('Temporary file path:', tempFilePathForCleanup);
    console.log('File size:', uploadedFile.size);
    console.log('----------------------');
    
    if (uploadedFile.size === 0) {
        console.error("Uploaded file is empty.");
        // Il cleanup avverrà nel blocco finally
        return res.status(400).json({ error: 'Audio file is empty.' });
    }
    
    // Crea un oggetto Uploadable usando toFile.
    // Questo passa lo stream del file insieme al suo nome originale (con estensione) all'API OpenAI,
    // aiutando l'API a determinare correttamente il tipo di file.
    const fileForOpenAI = await toFile(
        fs.createReadStream(tempFilePathForCleanup),
        originalFilename 
    );

    const transcription = await openai.audio.transcriptions.create({
      file: fileForOpenAI, // Passa l'oggetto Uploadable
      model: "whisper-1",
      language: "it",
      response_format: "json",
    });

    console.log('Whisper Transcription successful:', transcription.text);
    
    res.status(200).json({ transcript: transcription.text });

  } catch (error) {
    console.error('Error in /api/transcribe:', error);
    let userErrorMessage = 'Errore durante la trascrizione.';
    let statusCode = 500;

    // Controlla se l'errore proviene dall'API di OpenAI
    if (error.response && error.response.data && error.response.data.error) {
        console.error('OpenAI API Error Details:', JSON.stringify(error.response.data.error, null, 2));
        userErrorMessage = error.response.data.error.message || userErrorMessage;
        // Aggiungi il codice di errore OpenAI se disponibile e rilevante
        if (error.response.data.error.code) {
            userErrorMessage = `[Codice OpenAI: ${error.response.data.error.code}] ${userErrorMessage}`;
        }
        statusCode = error.response.status || statusCode;

        // Se l'errore specifico è "Invalid file format", lo rendiamo più esplicito
        if (userErrorMessage.toLowerCase().includes("invalid file format") || 
            (error.response.data.error.code && error.response.data.error.code === 'invalid_request_error' && userErrorMessage.toLowerCase().includes("supported format"))) {
             userErrorMessage = `Formato file audio non valido o non riconosciuto. Formati supportati: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. (Dettaglio: ${error.response.data.error.message})`;
        }

    } else if (error.message) { // Altri tipi di errori (es. di rete, file system)
        userErrorMessage = error.message;
        if (error.status) statusCode = error.status; 
    }
    
    res.status(statusCode).json({ error: userErrorMessage });
  } finally {
    // Cleanup del file temporaneo in ogni caso (successo o errore)
    if (tempFilePathForCleanup && fs.existsSync(tempFilePathForCleanup)) {
      fs.unlink(tempFilePathForCleanup, unlinkErr => {
        if (unlinkErr) console.error("Error deleting temp file in finally block:", unlinkErr);
        else console.log("Temp file deleted:", tempFilePathForCleanup);
      });
    }
  }
}
