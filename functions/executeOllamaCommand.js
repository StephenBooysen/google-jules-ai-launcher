const axios = require('axios');
const dotenv = require('dotenv');
const functions = require('@google-cloud/functions-framework');
const { InstancesClient } = require('@google-cloud/compute');

dotenv.config();

const executeOllamaCommandHTTP = async (req, res) => {
  try {
    const { instanceIp, instanceName, zone, ollamaCommand, commandPayload } = req.body;
    const project = process.env.GCLOUD_PROJECT;

    if (!project) {
      console.error('GCLOUD_PROJECT not set in .env file');
      res.status(500).send({ message: 'Server configuration error: GCLOUD_PROJECT not set.' });
      return;
    }

    // instanceIp is still needed to communicate with Ollama.
    // instanceName and zone are needed to update metadata.
    if (!instanceIp) {
      console.error('Missing instanceIp in request body');
      res.status(400).send({ message: 'Missing required field: instanceIp.' });
      return;
    }
    if (!instanceName) {
      console.error('Missing instanceName in request body for metadata update');
      res.status(400).send({ message: 'Missing required field: instanceName (for metadata update).' });
      return;
    }
    if (!zone) {
      console.error('Missing zone in request body for metadata update');
      res.status(400).send({ message: 'Missing required field: zone (for metadata update).' });
      return;
    }
    if (!ollamaCommand) {
      console.error('Missing ollamaCommand in request body');
      res.status(400).send({ message: 'Missing required field: ollamaCommand' });
      return;
    }

    const targetInstanceIp = instanceIp; // Using the provided IP. IP lookup is not part of this immediate task.
    const ollamaApiUrl = `http://${targetInstanceIp}:11434/api/${ollamaCommand}`;
    console.log(`Sending command '${ollamaCommand}' to Ollama instance at ${targetInstanceIp} (Instance: ${instanceName}, Zone: ${zone})`);
    console.log(`Payload:`, commandPayload);

    try {
      const ollamaResponse = await axios.post(ollamaApiUrl, commandPayload || {}, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 600000, // 10 minutes timeout for Ollama commands
      });

      console.log(`Received response from Ollama for command '${ollamaCommand}' for instance ${instanceName}.`);

      // Update GCE instance metadata for last-activity-timestamp
      try {
        const instancesClient = new InstancesClient();
        console.log(`Fetching metadata for instance ${instanceName} in zone ${zone} to update last-activity-timestamp.`);
        const [instanceData] = await instancesClient.get({ project, zone, instance: instanceName });
        const fingerprint = instanceData.metadata.fingerprint;
        const newTimestamp = new Date().toISOString();

        await instancesClient.setMetadata({
          project,
          zone,
          instance: instanceName,
          metadataResource: {
            fingerprint: fingerprint,
            items: [
              { key: 'last-activity-timestamp', value: newTimestamp }
            ]
          }
        });
        console.log(`Successfully updated last-activity-timestamp for ${instanceName} to ${newTimestamp}.`);
      } catch (metadataError) {
        console.error(`Failed to update last-activity-timestamp for ${instanceName}:`, metadataError);
        // Log the error but don't fail the entire operation, as the primary goal (Ollama command) succeeded.
        // The client will still get the Ollama response.
        // The inactivity script on the VM will eventually shut it down if timestamps are not updated.
      }

      res.status(200).send(ollamaResponse.data);

    } catch (error) {
      console.error(`Error executing Ollama command '${ollamaCommand}' on ${targetInstanceIp} (Instance: ${instanceName}):`, error.message);
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.error('Ollama API Error Data:', error.response.data);
        console.error('Ollama API Error Status:', error.response.status);
        console.error('Ollama API Error Headers:', error.response.headers);
        res.status(error.response.status).send({
          message: `Ollama API error for command '${ollamaCommand}'`,
          ollamaError: error.response.data,
          ollamaStatus: error.response.status,
        });
      } else if (error.request) {
        // The request was made but no response was received
        console.error('No response received from Ollama:', error.request);
        res.status(502).send({ message: `No response from Ollama for command '${ollamaCommand}'. Ensure the instance is running and Ollama service is accessible.` });
      } else {
        // Something happened in setting up the request that triggered an Error
        console.error('Axios request setup error:', error.message);
        res.status(500).send({ message: 'Error setting up request to Ollama.', error: error.message });
      }
    }

  } catch (error) {
    console.error('Unexpected error in executeOllamaCommand:', error);
    res.status(500).send({ message: 'Unexpected server error', error: error.message });
  }
};

exports.executeOllamaCommand = executeOllamaCommandHTTP;
functions.http('executeOllamaCommand', executeOllamaCommandHTTP);
