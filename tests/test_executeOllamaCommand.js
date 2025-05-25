const assert = require('assert');
const sinon = require('sinon');
const axios = require('axios'); // To mock axios.post
const { InstancesClient } = require('@google-cloud/compute');
const functionsFramework = require('@google-cloud/functions-framework');

let executeOllamaCommandHTTP;

describe('Cloud Function: executeOllamaCommand', () => {
    let mockReq, mockRes;
    let axiosPostStub;
    let instancesClientGetStub, instancesClientSetMetadataStub;
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.GCLOUD_PROJECT = 'test-project';
        // DEFAULT_ZONE is not directly used by executeOllamaCommand, but good practice to set if other tests depend on it.
        process.env.DEFAULT_ZONE = 'test-default-zone'; 

        // Mock axios
        axiosPostStub = sinon.stub(axios, 'post').resolves({ data: { response: 'ollama success' } });

        // Mock InstancesClient
        instancesClientGetStub = sinon.stub(); // To be configured per test
        instancesClientSetMetadataStub = sinon.stub().resolves(); // Mock successful metadata set

        sinon.stub(InstancesClient.prototype, 'get').callsFake(instancesClientGetStub);
        sinon.stub(InstancesClient.prototype, 'setMetadata').callsFake(instancesClientSetMetadataStub);
        
        mockRes = {
            status: sinon.stub().returnsThis(),
            send: sinon.stub(),
        };

        // Ensure fresh require for each test
        delete require.cache[require.resolve('../functions/executeOllamaCommand.js')];
        require('../functions/executeOllamaCommand.js');
        executeOllamaCommandHTTP = functionsFramework.getFunction('executeOllamaCommand');

        if (!executeOllamaCommandHTTP) {
            const executeOllamaCommandModule = require('../functions/executeOllamaCommand.js');
            executeOllamaCommandHTTP = executeOllamaCommandModule.executeOllamaCommand;
        }
    });

    afterEach(() => {
        sinon.restore();
        process.env = originalEnv;
        delete require.cache[require.resolve('../functions/executeOllamaCommand.js')];
    });

    it('Test 1: Ollama URL construction and basic call', async () => {
        mockReq = {
            body: {
                instanceIp: '10.0.0.1',
                instanceName: 'test-vm',
                zone: 'us-central1-a',
                ollamaCommand: 'generate',
                commandPayload: { model: 'llama2', prompt: 'Hi' }
            }
        };

        await executeOllamaCommandHTTP(mockReq, mockRes);

        assert(axiosPostStub.calledOnce, 'axios.post should be called once');
        const axiosCallArgs = axiosPostStub.firstCall.args;
        assert.strictEqual(axiosCallArgs[0], 'http://10.0.0.1:11434/api/generate', 'Ollama URL is incorrect');
        assert.deepStrictEqual(axiosCallArgs[1], { model: 'llama2', prompt: 'Hi' }, 'Ollama payload is incorrect');
        
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
        assert(mockRes.send.calledWith({ response: 'ollama success' }), 'Response data not as expected');
    });

    it('Test 2: Metadata update attempt', async () => {
        mockReq = {
            body: {
                instanceIp: '10.0.0.2',
                instanceName: 'metadata-vm',
                zone: 'europe-west1-b',
                ollamaCommand: 'pull',
                commandPayload: { name: 'phi3' }
            }
        };
        // Mock for fetching metadata fingerprint
        instancesClientGetStub.resolves([{ metadata: { fingerprint: 'test-fingerprint' } }]); 

        const beforeTimestamp = new Date(Date.now() - 2000).toISOString();
        await executeOllamaCommandHTTP(mockReq, mockRes);
        const afterTimestamp = new Date(Date.now() + 2000).toISOString();


        assert(axiosPostStub.calledOnce, 'axios.post should be called');
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
        
        assert(instancesClientGetStub.calledOnceWith(sinon.match({
            project: 'test-project',
            zone: 'europe-west1-b',
            instance: 'metadata-vm'
        })), 'InstancesClient.get not called correctly for fingerprint');

        assert(instancesClientSetMetadataStub.calledOnce, 'InstancesClient.setMetadata should be called once');
        const setMetadataArgs = instancesClientSetMetadataStub.firstCall.args[0];
        assert.strictEqual(setMetadataArgs.project, 'test-project', 'Project for setMetadata incorrect');
        assert.strictEqual(setMetadataArgs.zone, 'europe-west1-b', 'Zone for setMetadata incorrect');
        assert.strictEqual(setMetadataArgs.instance, 'metadata-vm', 'Instance name for setMetadata incorrect');
        assert.strictEqual(setMetadataArgs.metadataResource.fingerprint, 'test-fingerprint', 'Fingerprint incorrect');
        
        const lastActivityItem = setMetadataArgs.metadataResource.items.find(item => item.key === 'last-activity-timestamp');
        assert(lastActivityItem, 'last-activity-timestamp not found in metadata update');
        assert(lastActivityItem.value >= beforeTimestamp && lastActivityItem.value <= afterTimestamp, 'last-activity-timestamp is not a recent ISO string');
    });

    it('Test 3: Missing instanceIp parameter', async () => {
        mockReq = {
            body: {
                // instanceIp is missing
                instanceName: 'no-ip-vm',
                zone: 'us-east1-c',
                ollamaCommand: 'show',
                commandPayload: { name: 'gemma' }
            }
        };

        await executeOllamaCommandHTTP(mockReq, mockRes);

        assert(axiosPostStub.notCalled, 'axios.post should not be called');
        assert(instancesClientSetMetadataStub.notCalled, 'InstancesClient.setMetadata should not be called');
        assert(mockRes.status.calledWith(400), 'Response status should be 400 for missing instanceIp');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Missing required field: instanceIp.' })), 'Correct error message not sent');
    });
    
    it('Test 4: Missing instanceName parameter', async () => {
        mockReq = {
            body: {
                instanceIp: '1.2.3.4',
                // instanceName is missing
                zone: 'us-east1-c',
                ollamaCommand: 'show',
                commandPayload: { name: 'gemma' }
            }
        };

        await executeOllamaCommandHTTP(mockReq, mockRes);
        assert(mockRes.status.calledWith(400), 'Response status should be 400');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Missing required field: instanceName (for metadata update).' })), 'Correct error message not sent');
    });
    
    it('Test 5: Missing zone parameter', async () => {
        mockReq = {
            body: {
                instanceIp: '1.2.3.4',
                instanceName: 'test-vm',
                // zone is missing
                ollamaCommand: 'show',
                commandPayload: { name: 'gemma' }
            }
        };

        await executeOllamaCommandHTTP(mockReq, mockRes);
        assert(mockRes.status.calledWith(400), 'Response status should be 400');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Missing required field: zone (for metadata update).' })), 'Correct error message not sent');
    });


    it('Test 6: Missing ollamaCommand parameter', async () => {
        mockReq = {
            body: {
                instanceIp: '1.2.3.4',
                instanceName: 'no-cmd-vm',
                zone: 'us-west1-a',
                // ollamaCommand is missing
                commandPayload: { model: 'llama2' }
            }
        };

        await executeOllamaCommandHTTP(mockReq, mockRes);

        assert(axiosPostStub.notCalled, 'axios.post should not be called');
        assert(mockRes.status.calledWith(400), 'Response status should be 400 for missing ollamaCommand');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Missing required field: ollamaCommand' })), 'Correct error message not sent');
    });
    
    it('Should return 500 if GCLOUD_PROJECT is not set', async () => {
        delete process.env.GCLOUD_PROJECT;
        
        delete require.cache[require.resolve('../functions/executeOllamaCommand.js')];
        require('../functions/executeOllamaCommand.js');
        executeOllamaCommandHTTP = functionsFramework.getFunction('executeOllamaCommand');
         if (!executeOllamaCommandHTTP) {
            const module = require('../functions/executeOllamaCommand.js');
            executeOllamaCommandHTTP = module.executeOllamaCommand;
        }

        mockReq = { body: { instanceIp: '1.1.1.1', instanceName: 'a', zone: 'b', ollamaCommand: 'c' } }; // Provide all required fields
        await executeOllamaCommandHTTP(mockReq, mockRes);

        assert(mockRes.status.calledWith(500), 'Response status should be 500');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Server configuration error: GCLOUD_PROJECT not set.'})), 'Correct error message not sent');
        assert(axiosPostStub.notCalled, 'axios.post should not be called');
    });

    it('Should handle Ollama API error (error.response)', async () => {
        mockReq = {
            body: {
                instanceIp: '10.0.0.1',
                instanceName: 'test-vm',
                zone: 'us-central1-a',
                ollamaCommand: 'generate',
                commandPayload: { model: 'llama2', prompt: 'Hi' }
            }
        };
        axiosPostStub.reset(); // Reset original stub
        axiosPostStub.rejects({ 
            response: { 
                status: 503, 
                data: { error: "Ollama server busy" } 
            } 
        });


        await executeOllamaCommandHTTP(mockReq, mockRes);

        assert(axiosPostStub.calledOnce, 'axios.post should be called');
        assert(mockRes.status.calledWith(503), 'Response status should be 503 from Ollama');
        assert(mockRes.send.calledWith(sinon.match({ 
            message: "Ollama API error for command 'generate'",
            ollamaError: { error: "Ollama server busy" }
        })), 'Response data not as expected for Ollama error');
        // Metadata update should still be attempted if Ollama call fails this way
        // assert(instancesClientGetStub.calledOnce, 'instancesClient.get should have been called even on Ollama error for metadata');
        // This behavior might be debatable: should we update timestamp if the command failed?
        // Current code updates *after* successful ollamaResponse. So, it won't be called.
        assert(instancesClientGetStub.notCalled, 'instancesClient.get should NOT be called if Ollama command fails before it.');
    });

    it('Should handle Ollama no response error (error.request)', async () => {
        mockReq = {
            body: {
                instanceIp: '10.0.0.1',
                instanceName: 'test-vm',
                zone: 'us-central1-a',
                ollamaCommand: 'generate',
                commandPayload: { model: 'llama2', prompt: 'Hi' }
            }
        };
        axiosPostStub.reset();
        axiosPostStub.rejects({ request: {} }); // Simulate no response

        await executeOllamaCommandHTTP(mockReq, mockRes);

        assert(axiosPostStub.calledOnce, 'axios.post should be called');
        assert(mockRes.status.calledWith(502), 'Response status should be 502 for no response');
        assert(mockRes.send.calledWith(sinon.match({ message: "No response from Ollama for command 'generate'. Ensure the instance is running and Ollama service is accessible." })), 'Correct error message not sent');
        assert(instancesClientGetStub.notCalled, 'instancesClient.get should NOT be called if Ollama command fails.');
    });
});
