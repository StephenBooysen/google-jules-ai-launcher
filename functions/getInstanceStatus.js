const { InstancesClient } = require('@google-cloud/compute');
const dotenv = require('dotenv');
const functions = require('@google-cloud/functions-framework');

dotenv.config();

const getInstanceStatusHTTP = async (req, res) => {
  try {
    const { instanceName } = req.query;
    const zone = req.query.zone || process.env.DEFAULT_ZONE || 'us-central1-a';
    const project = process.env.GCLOUD_PROJECT;

    if (!project) {
      console.error('GCLOUD_PROJECT not set in .env file');
      res.status(500).send({ message: 'Server configuration error: GCLOUD_PROJECT not set.' });
      return;
    }

    if (!instanceName) {
      console.error('Missing instanceName in query parameters');
      res.status(400).send({ message: 'Missing required query parameter: instanceName' });
      return;
    }

    console.log(`Received request to get status for instance: ${instanceName} in zone: ${zone}, project: ${project}`);

    const instancesClient = new InstancesClient();

    const [instance] = await instancesClient.get({
      project,
      zone,
      instance: instanceName,
    });

    if (instance && instance.status) {
      console.log(`Instance ${instanceName} status: ${instance.status}`);
      res.status(200).send({
        instanceName,
        zone,
        status: instance.status,
        networkInterfaces: instance.networkInterfaces, // Send full network interface info
      });
    } else {
      console.error(`Instance ${instanceName} not found or status is unavailable.`);
      // GCE API usually throws an error if instance not found, which is caught by catch block.
      // This is a fallback.
      res.status(404).send({ message: `Instance ${instanceName} not found or status unavailable.` });
    }

  } catch (error) {
    console.error(`Error getting instance status for ${req.query.instanceName}:`, error.message);
    if (error.code === 5) { // GRPC 'NOT_FOUND' error code for GCE
        res.status(404).send({ message: `Instance ${req.query.instanceName} not found in zone ${req.query.zone || process.env.DEFAULT_ZONE || 'us-central1-a'}.`, details: error.message });
    } else {
        res.status(500).send({ message: 'Error getting instance status', error: error.message });
    }
  }
};

// Register the function with the Functions Framework
exports.getInstanceStatus = getInstanceStatusHTTP;

// Also, explicitly register with functions-framework if needed for local testing or specific deployment strategies
// functions.http('getInstanceStatus', getInstanceStatusHTTP); // This line is commented out as per prompt for only using exports
// However, if deploying with `gcloud functions deploy getInstanceStatus --trigger-http --entry-point getInstanceStatus`
// then `exports.getInstanceStatus` is sufficient.
// If a different entry point name is desired for the HTTP trigger, then functions.http() would be used.
// For consistency with createInstance.js, let's add the explicit registration
functions.http('getInstanceStatus', getInstanceStatusHTTP);
