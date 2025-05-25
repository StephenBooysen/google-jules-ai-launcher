document.addEventListener('DOMContentLoaded', () => {
    // Get references to HTML elements
    const modelNameInput = document.getElementById('modelNameInput');
    const zoneInput = document.getElementById('zoneInput');
    const createVmButton = document.getElementById('createVmButton');

    const instanceNameStatusInput = document.getElementById('instanceNameStatusInput');
    const zoneStatusInput = document.getElementById('zoneStatusInput');
    const getStatusButton = document.getElementById('getStatusButton');
    const vmStatusDisplay = document.getElementById('vmStatusDisplay');

    const instanceIpInput = document.getElementById('instanceIpInput');
    const ollamaCommandInput = document.getElementById('ollamaCommandInput');
    const commandPayloadInput = document.getElementById('commandPayloadInput');
    const sendCommandButton = document.getElementById('sendCommandButton');
    const ollamaResponseDisplay = document.getElementById('ollamaResponseDisplay');

    const logsDisplay = document.getElementById('logsDisplay');

    const CLOUD_FUNCTION_BASE_URL = ''; // Adjust if testing locally with a prefix or when deployed

    // Helper function to log messages to the logsDisplay pre
    function logMessage(message, data) {
        const timestamp = new Date().toLocaleTimeString();
        logsDisplay.textContent += `[${timestamp}] ${message}\n`;
        if (data) {
            logsDisplay.textContent += `${JSON.stringify(data, null, 2)}\n`;
        }
        logsDisplay.scrollTop = logsDisplay.scrollHeight; // Scroll to bottom
    }

    // Event Listener for "Create VM"
    createVmButton.addEventListener('click', async () => {
        const modelName = modelNameInput.value.trim();
        const zone = zoneInput.value.trim() || 'us-central1-a'; // Default zone if empty

        logMessage(`Attempting to create VM with model: ${modelName} in zone: ${zone}...`);
        vmStatusDisplay.textContent = 'Initiating VM creation...';

        try {
            const response = await fetch(`${CLOUD_FUNCTION_BASE_URL}/createInstance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelName, zone }),
            });

            const result = await response.json();

            if (response.ok) {
                logMessage('VM creation initiated successfully:', result);
                vmStatusDisplay.textContent = `Instance Name: ${result.instanceName}\nStatus: ${result.status}\nIP: ${result.externalIp || 'Pending'}\nZone: ${result.zone}\nModel: ${result.modelName}`;
                instanceNameStatusInput.value = result.instanceName;
                zoneStatusInput.value = result.zone;
                if (result.externalIp) {
                    instanceIpInput.value = result.externalIp;
                }
            } else {
                logMessage('VM creation failed:', result);
                vmStatusDisplay.textContent = `Error: ${result.message || 'Unknown error'}\nDetails: ${result.error || ''}`;
            }
        } catch (error) {
            logMessage('Error during VM creation request:', error);
            vmStatusDisplay.textContent = `Network or parsing error: ${error.message}`;
        }
    });

    // Event Listener for "Get VM Status"
    getStatusButton.addEventListener('click', async () => {
        const instanceName = instanceNameStatusInput.value.trim();
        const zone = zoneStatusInput.value.trim() || 'us-central1-a'; // Default zone if empty

        if (!instanceName) {
            logMessage('Instance Name for status check is required.');
            vmStatusDisplay.textContent = 'Please enter an Instance Name.';
            return;
        }

        logMessage(`Fetching VM status for: ${instanceName} in zone: ${zone}...`);
        vmStatusDisplay.textContent = `Fetching status for ${instanceName}...`;

        try {
            const response = await fetch(`${CLOUD_FUNCTION_BASE_URL}/getInstanceStatus?instanceName=${encodeURIComponent(instanceName)}&zone=${encodeURIComponent(zone)}`, {
                method: 'GET',
            });

            const result = await response.json();

            if (response.ok) {
                logMessage('VM status received:', result);
                vmStatusDisplay.textContent = `Instance Name: ${result.instanceName}\nZone: ${result.zone}\nStatus: ${result.status}\nNetwork Interfaces: ${JSON.stringify(result.networkInterfaces, null, 2)}`;
                 // Populate IP if available and not already set
                if (!instanceIpInput.value && result.networkInterfaces && result.networkInterfaces[0] && result.networkInterfaces[0].accessConfigs && result.networkInterfaces[0].accessConfigs[0] && result.networkInterfaces[0].accessConfigs[0].natIP) {
                    instanceIpInput.value = result.networkInterfaces[0].accessConfigs[0].natIP;
                    logMessage(`Populated Instance IP from status: ${instanceIpInput.value}`);
                }
            } else {
                logMessage('Failed to get VM status:', result);
                vmStatusDisplay.textContent = `Error: ${result.message || 'Unknown error'}`;
            }
        } catch (error) {
            logMessage('Error during VM status request:', error);
            vmStatusDisplay.textContent = `Network or parsing error: ${error.message}`;
        }
    });

    // Event Listener for "Send Command"
    sendCommandButton.addEventListener('click', async () => {
        const instanceIp = instanceIpInput.value.trim();
        const instanceName = instanceNameStatusInput.value.trim(); // Get instanceName for metadata update
        const zone = zoneStatusInput.value.trim(); // Get zone for metadata update
        const ollamaCommand = ollamaCommandInput.value.trim().replace(/^\/api\//, ''); // Ensure command is like 'generate', 'pull'
        const commandPayloadStr = commandPayloadInput.value;

        if (!instanceIp) {
            logMessage('Instance IP is required to send a command.');
            ollamaResponseDisplay.textContent = 'Please enter the Instance IP.';
            return;
        }
        if (!instanceName) {
            logMessage('Instance Name is required for metadata updates. Please create or get status of a VM first.');
            ollamaResponseDisplay.textContent = 'Please enter the Instance Name (from VM Status).';
            return;
        }
        if (!zone) {
            logMessage('Zone is required for metadata updates. Please create or get status of a VM first.');
            ollamaResponseDisplay.textContent = 'Please enter the Zone (from VM Status).';
            return;
        }
        if (!ollamaCommand) {
            logMessage('Ollama command endpoint is required.');
            ollamaResponseDisplay.textContent = 'Please enter the Ollama command (e.g., generate, pull).';
            return;
        }

        let commandPayload;
        try {
            commandPayload = JSON.parse(commandPayloadStr);
        } catch (e) {
            logMessage('Invalid JSON in command payload:', e);
            ollamaResponseDisplay.textContent = `Error: Invalid JSON in payload - ${e.message}`;
            return;
        }

        logMessage(`Sending command '${ollamaCommand}' to Ollama at ${instanceIp} (Instance: ${instanceName}, Zone: ${zone})...`, commandPayload);
        ollamaResponseDisplay.textContent = `Sending command to ${instanceIp}...`;

        try {
            const response = await fetch(`${CLOUD_FUNCTION_BASE_URL}/executeOllamaCommand`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    instanceIp,
                    instanceName, // Added for metadata update
                    zone,         // Added for metadata update
                    ollamaCommand,
                    commandPayload,
                }),
            });

            // Handle different types of responses (streaming vs. non-streaming)
            const contentType = response.headers.get("content-type");
            let resultText;

            if (contentType && contentType.includes("application/x-ndjson")) {
                logMessage(`Received streaming response for command '${ollamaCommand}'.`);
                resultText = "";
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                ollamaResponseDisplay.textContent = ""; // Clear previous before streaming

                // Read the stream
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    resultText += chunk;
                    ollamaResponseDisplay.textContent += chunk; // Display chunk by chunk
                }
                logMessage(`Stream ended for command '${ollamaCommand}'. Full response:`, resultText);
            } else if (contentType && contentType.includes("application/json")){
                const resultJson = await response.json();
                 if (response.ok) {
                    logMessage(`Command '${ollamaCommand}' successful:`, resultJson);
                    resultText = JSON.stringify(resultJson, null, 2);
                } else {
                    logMessage(`Command '${ollamaCommand}' failed:`, resultJson);
                    resultText = `Error: ${resultJson.message || response.statusText}\nDetails: ${JSON.stringify(resultJson.ollamaError || resultJson.error || resultJson, null, 2)}`;
                }
                ollamaResponseDisplay.textContent = resultText;
            } else {
                resultText = await response.text();
                 if (response.ok) {
                    logMessage(`Command '${ollamaCommand}' successful (non-JSON response):`, resultText);
                } else {
                    logMessage(`Command '${ollamaCommand}' failed (non-JSON response):`, resultText);
                }
                ollamaResponseDisplay.textContent = resultText;
            }

        } catch (error) {
            logMessage(`Error during Ollama command '${ollamaCommand}':`, error);
            ollamaResponseDisplay.textContent = `Network or parsing error: ${error.message}`;
        }
    });
});
