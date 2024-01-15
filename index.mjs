import express from 'express';
import logger from 'morgan';
import bodyParser from 'body-parser';
import { twiml, twilio as Twilio } from 'twilio';
import axios from 'axios';
import { Router } from 'express';
import dotenv from 'dotenv';

dotenv.config();

const globals = {
    TWILIO_PHONE_NUMBER     : "+18556998467",
    TWILIO_ACCOUNT_SID      : "AC762c0c7bcd2d90fc35f4917c6445e397",
    TWILIO_AUTH_TOKEN       : "cdf6a57fb5919b9e805f14b27e7aab72",
    VOICEFLOW_API_KEY       : "VF.DM.659f3367213c970007153034.04p2pQumxTYhGAux",
    VOICEFLOW_VERSION_ID    : "659f28896e8269a135ddc3cf", 
    VOICEFLOW_PROJECT_ID    : "659f28896e8269a135ddc3ce",
}

const SMS = Twilio(globals.TWILIO_ACCOUNT_SID, globals.TWILIO_AUTH_TOKEN);

const createSession = () => {
    const randomNo = Math.floor(Math.random() * 1000 + 1);
    const timestamp = Date.now();
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = weekday[new Date().getDay()];
    return randomNo + day + timestamp;
};

let session = `${globals.VOICEFLOW_VERSION_ID}.${createSession()}`;

const logTranscript = async (message) => {
  const sheetid = "1XNbbvjnF8GCiDgls0FI0K3GfmoinOcwfcd5nlIRpgD4";
  const lambdaURL = "https://ytzivrzj76ejwc2vdbnzwladdm0nvubi.lambda-url.us-east-1.on.aws/";

  try {
    await axios.post(lambdaURL, {
      "sheetid": sheetid,
      "message": message
    });
    console.log(`Logged in the following sheet: https://docs.google.com/spreadsheets/d/${sheetid}`);
  } catch (err) {
    console.log(`------- ERROR: ${err}`);
  }
};

const saveTranscript = async (username) => {
  if (globals.VOICEFLOW_PROJECT_ID) {
    if (!username || username === '') username = 'Anonymous';
    try {
      await axios.put('https://api.voiceflow.com/v2/transcripts', {
        sessionID: session,
        versionID: globals.VOICEFLOW_VERSION_ID,
        projectID: globals.VOICEFLOW_PROJECT_ID,
        device: 'Phone',
        os: 'Twilio',
        browser: 'Twilio',
        user: {
          name: username,
          image: 'https://s3.amazonaws.com/com.voiceflow.studio/share/twilio-logo-png-transparent/twilio-logo-png-transparent.png',
        },
      }, {
        headers: { Authorization: globals.VOICEFLOW_API_KEY },
      });
      console.log('Saved!');
      session = `${globals.VOICEFLOW_VERSION_ID}.${createSession()}`;
    } catch (err) {
      console.log(`------- ERROR: ${err}`);
    }
  }
};

const interact = async (caller, action) => {
    const voiceResponse = new Twilio.twiml.VoiceResponse();
    const request = {
      method: 'POST',
      url: `https://general-runtime.voiceflow.com/state/user/${encodeURI(caller)}/interact`,
      headers: { Authorization: globals.VOICEFLOW_API_KEY, sessionid: session },
      data: { action, config: { stopTypes: ['DTMF'] } },
    };
  
    const response = await axios(request);
    //await logTranscript(JSON.stringify(response.data));
  
    const endTurn = response.data.some(trace => ['CALL', 'end'].includes(trace.type));
    const agent = endTurn ? voiceResponse : voiceResponse.gather({
      input: 'speech dtmf',
      numDigits: 1,
      speechTimeout: 'auto',
      action: '/ivr/interaction',
      profanityFilter: false,
      actionOnEmptyResult: true,
      method: 'POST',
    });
  
    for (const trace of response.data) {
      switch (trace.type) {
        case 'text':
        case 'speak':
          agent.say(trace.payload.message);
          //await logTranscript(trace.payload.message);
          break;
        case 'CALL':
          const { number } = JSON.parse(trace.payload);
          voiceResponse.dial(number);
          //await logTranscript(`Calling: ${number}`);
          break;
        case 'SMS':
          const { message } = JSON.parse(trace.payload);
          SMS.messages.create({
            body: message,
            to: caller,
            from: globals.TWILIO_PHONE_NUMBER
          }).then((message) => {
            console.log('Message sent, SID:', message.sid);
          }).catch((error) => {
            console.error('Error sending message:', error);
          });
          //await logTranscript(`Sending SMS: ${message}`);
          break;
        case 'end':
          voiceResponse.hangup();
          break;
        default:
          break;
      }
    }
    return voiceResponse.toString();
  };  

const launch = async (called, caller) => {
return interact(caller, { type: 'launch' });
};

const interaction = async (called, caller, query = '', digit = null) => {

    let action = null;
    
    if (digit) {
      action = { type: `${digit}` };
    } else if (query.trim()) {
      query = query.endsWith('.') ? query.slice(0, -1) : query;
      action = { type: 'text', payload: query };
    }

    return interact(caller, action);
};
  
const handler = async () => {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(logger('dev'));
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));

    // Main Router
    const mainRouter = new Router();

    mainRouter.post('/interaction', async (req, res) => {
        const { Called, Caller, SpeechResult, Digits } = req.body;
        res.send(await interaction(Called, Caller, SpeechResult, Digits));
    });

    mainRouter.post('/launch', async (req, res) => {
        const { Called, Caller } = req.body;
        res.send(await launch(Called, Caller));
    });

    // IVR Router
    const ivrRouter = new Router();

    ivrRouter.get('/', async (req, res) => {
        res.send('Voiceflow Twilio Integration is up and running');
    });

    // POST route for handling IVR interactions with Twilio webhook
    ivrRouter.post('/ivr', Twilio.webhook({ validate: false }), async (req, res) => {
        // Your IVR interaction handling logic here
        // ...

        // Respond with TwiML
        const twimlResponse = new Twilio.twiml.VoiceResponse();
        // ... use twimlResponse to build your Twilio Voice Response ...

        res.type('text/xml');
        res.send(twimlResponse.toString());
    });

    app.use('/ivr', ivrRouter);
    app.use(mainRouter);

    // Error handling
    app.use((req, res, next) => {
        const err = new Error('Not Found');
        err.status = 404;
        next(err);
    });

    app.use((err, req, res, next) => {
        res.status(err.status || 500);
        res.send('error');
    });

    // Start server
    const server = app.listen(port, () => {
        console.log(`Express server listening on port ${server.address().port}`);
    });
};

handler();