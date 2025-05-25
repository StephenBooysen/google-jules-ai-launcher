const { InstancesClient } = require('@google-cloud/compute');
const dotenv = require('dotenv');
const functions = require('@google-cloud/functions-framework');

dotenv.config();

const createInstanceHTTP = async (req, res) => {
  try {
    const { modelName = 'llama2', zone = process.env.DEFAULT_ZONE || 'us-central1-a' } = req.body;
    const project = process.env.GCLOUD_PROJECT;

    if (!project) {
      console.error('GCLOUD_PROJECT not set in .env file');
      res.status(500).send('Server configuration error: GCLOUD_PROJECT not set.');
      return;
    }

    console.log(`Received request to create instance with model: ${modelName} in zone: ${zone}`);

    const instancesClient = new InstancesClient();
    const instanceName = `ollama-vm-${Date.now()}`;

    const startupScript = `#!/bin/bash
echo "Startup script started." > /var/log/startup-script.log

# Install Docker
apt-get update
apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
echo "Docker installed." >> /var/log/startup-script.log

# Pull Ollama image and run container
docker pull ollama/ollama
docker run -d --gpus all -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama
echo "Ollama container started." >> /var/log/startup-script.log

# Wait for Ollama to be ready (simple sleep, can be improved)
sleep 60 

# Pull the specified model
docker exec ollama ollama pull ${modelName}
echo "Ollama model ${modelName} pull initiated." >> /var/log/startup-script.log

# Inactivity shutdown logic
(
  echo "VM Inactivity Shutdown: Monitoring started. Will check every 60 seconds for 15 minutes of inactivity." >> /var/log/startup-script.log
  while true; do
    sleep 60
    LAST_ACTIVITY_TIMESTAMP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/last-activity-timestamp)
    if [ -z "$LAST_ACTIVITY_TIMESTAMP" ]; then
      echo "VM Inactivity Shutdown: last-activity-timestamp not found. Using startup-timestamp." >> /var/log/startup-script.log
      STARTUP_TIMESTAMP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/startup-timestamp)
      if [ -z "$STARTUP_TIMESTAMP" ]; then
        echo "VM Inactivity Shutdown: Neither startup-timestamp nor last-activity-timestamp found. Waiting." >> /var/log/startup-script.log
        continue
      fi
      LAST_ACTIVITY_TIMESTAMP=$STARTUP_TIMESTAMP
    fi

    # Convert ISO timestamp to seconds since epoch
    LAST_ACTIVITY_SECONDS=$(date -d "$LAST_ACTIVITY_TIMESTAMP" +%s 2>/dev/null)
    if ! [[ "$LAST_ACTIVITY_SECONDS" =~ ^[0-9]+$ ]]; then # Check if it's a valid number
       echo "VM Inactivity Shutdown: Failed to parse LAST_ACTIVITY_TIMESTAMP: '$LAST_ACTIVITY_TIMESTAMP'. Contains non-numeric characters or is empty after parsing. Waiting." >> /var/log/startup-script.log
       continue
    fi
    
    CURRENT_SECONDS=$(date +%s)
    ELAPSED_SECONDS=$((CURRENT_SECONDS - LAST_ACTIVITY_SECONDS))

    echo "VM Inactivity Shutdown: Last activity $ELAPSED_SECONDS seconds ago (Threshold: 900s)." >> /var/log/startup-script.log

    if [ "$ELAPSED_SECONDS" -gt 900 ]; then # 15 minutes = 900 seconds
      echo "VM Inactivity Shutdown: Exceeded 15 minutes of inactivity. Shutting down." >> /var/log/startup-script.log
      sudo shutdown -h now
      exit 0 # Exit script after initiating shutdown
    fi
  done
) &

echo "Startup script finished. Inactivity monitor started in background." >> /var/log/startup-script.log
`;
    const initialTimestamp = new Date().toISOString();
    const insertRequest = {
      project,
      zone,
      instanceResource: {
        name: instanceName,
        machineType: `zones/${zone}/machineTypes/n1-standard-2`,
        displayDevice: {
          enableDisplay: true,
        },
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage: 'projects/debian-cloud/global/images/family/debian-11',
              diskSizeGb: '50',
            },
          },
        ],
        networkInterfaces: [
          {
            name: 'global/networks/default', // Use default network
            accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }],
          },
        ],
        serviceAccounts: [
          {
            email: 'default', // Use default service account
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
        ],
        metadata: {
          items: [
            {
              key: 'startup-script',
              value: startupScript,
            },
            { key: 'startup-timestamp', value: initialTimestamp },
            { key: 'last-activity-timestamp', value: initialTimestamp }
          ],
        },
      },
    };

    console.log(`Creating instance ${instanceName} in project ${project}, zone ${zone}...`);
    const [operation] = await instancesClient.insert(insertRequest);
    console.log(`Instance creation operation started: ${operation.name}`);

    // Wait for the operation to complete
    await operation.promise();
    console.log(`Instance ${instanceName} created successfully.`);

    // Get instance details to find the external IP
    const [instance] = await instancesClient.get({
      project,
      zone,
      instance: instanceName,
    });

    const externalIp = instance.networkInterfaces[0]?.accessConfigs[0]?.natIP;
    const status = instance.status;

    console.log(`Instance ${instanceName} status: ${status}, IP: ${externalIp}`);
    res.status(200).send({
      message: `Instance ${instanceName} creation initiated.`,
      instanceName,
      status,
      externalIp: externalIp || 'IP not available yet. Check VM status.',
      zone,
      modelName,
    });

  } catch (error) {
    console.error('Error creating instance:', error);
    res.status(500).send({ message: 'Error creating instance', error: error.message });
  }
};

// Register the function with the Functions Framework
// For CommonJS, use exports
exports.createInstance = createInstanceHTTP;

// If using ES Modules (type: "module" in package.json), you would use:
// import { http } from '@google-cloud/functions-framework';
// http('createInstance', createInstanceHTTP);
// For now, assuming CommonJS as per instructions.
// The functions-framework will typically look for a function exported with the name specified in package.json or deploy command.
// If deploying with `gcloud functions deploy createInstance --trigger-http --entry-point createInstance`
// then `exports.createInstance` is correct.
// Or, if using `functions.http('functionNameForHttp', actualFunction)`
// functions.http('createInstanceHttp', createInstanceHTTP); // This would make the endpoint name 'createInstanceHttp'
// The prompt asked for `functions.http('createInstance', createInstanceHTTP);` which implies the function to be invoked by HTTP is named 'createInstance'
// and the actual JS function is createInstanceHTTP.
// Let's stick to the explicit registration for clarity.
functions.http('createInstance', createInstanceHTTP);
