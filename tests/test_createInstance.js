const assert = require('assert');
const sinon = require('sinon');
const { InstancesClient } = require('@google-cloud/compute'); // To mock it
const functionsFramework = require('@google-cloud/functions-framework');

// Helper to register the function if it's not already registered by direct require
// This is tricky because the function auto-registers via functions.http
// We might need to manually call the registered function or export the core logic
let createInstanceHTTP;

describe('Cloud Function: createInstance', () => {
    let mockReq, mockRes;
    let instancesClientStub, insertStub, getStub;
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.GCLOUD_PROJECT = 'test-project';
        process.env.DEFAULT_ZONE = 'test-default-zone';

        // Mock InstancesClient
        insertStub = sinon.stub().resolves([{ promise: () => Promise.resolve() }]); // Mock operation.promise()
        getStub = sinon.stub().resolves([{ 
            name: 'test-instance', 
            status: 'RUNNING', 
            networkInterfaces: [{ accessConfigs: [{ natIP: '123.123.123.123' }] }] 
        }]);
        
        const mockInstancesClient = {
            insert: insertStub,
            get: getStub,
        };
        // This is a common way to stub a class constructor if the actual module is loaded
        // For @google-cloud/compute, the client is usually new InstancesClient()
        // We need to ensure our stub is used.
        // A cleaner way would be to use proxyquire or inject the client, but for now:
        sinon.stub(InstancesClient.prototype, 'insert').callsFake(insertStub);
        sinon.stub(InstancesClient.prototype, 'get').callsFake(getStub);


        // Mock Express response
        mockRes = {
            status: sinon.stub().returnsThis(),
            send: sinon.stub(),
        };
        
        // Dynamically require the function to ensure it's fresh for each test run
        // and to get the HTTP-triggered function.
        // This relies on functions-framework registering it.
        // We need to ensure the function is loaded AFTER stubs are in place.
        delete require.cache[require.resolve('../functions/createInstance.js')];
        require('../functions/createInstance.js'); 
        createInstanceHTTP = functionsFramework.getFunction('createInstance');

        if (!createInstanceHTTP) {
            // Fallback if getFunction doesn't work as expected in test env
            // This might happen if the function is not registered in time or testing setup is tricky
            // This requires createInstance.js to export createInstanceHTTP for this to work
            const createInstanceModule = require('../functions/createInstance.js');
            createInstanceHTTP = createInstanceModule.createInstance; // Assuming it's exported like this
        }
    });

    afterEach(() => {
        sinon.restore();
        process.env = originalEnv;
        delete require.cache[require.resolve('../functions/createInstance.js')];
    });

    it('Test 1: Default values for modelName and zone', async () => {
        mockReq = { body: {} };
        await createInstanceHTTP(mockReq, mockRes);

        assert(insertStub.calledOnce, 'InstancesClient.insert should be called once');
        const callArgs = insertStub.firstCall.args[0];
        assert(callArgs.instanceResource.name.startsWith('ollama-vm-'), 'Instance name should start with ollama-vm-');
        
        // Check for default modelName in startup script
        const startupScript = callArgs.instanceResource.metadata.items.find(item => item.key === 'startup-script').value;
        assert(startupScript.includes('ollama pull llama2'), 'Default modelName "llama2" not found in startup script');
        
        assert.strictEqual(callArgs.project, 'test-project', 'Project ID should be test-project');
        assert.strictEqual(callArgs.zone, 'test-default-zone', 'Zone should be test-default-zone');
        
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
        assert(mockRes.send.calledOnce, 'Response send should be called once');
    });

    it('Test 2: Startup script model name replacement', async () => {
        mockReq = { body: { modelName: 'test-model', zone: 'custom-zone' } };
        await createInstanceHTTP(mockReq, mockRes);

        assert(insertStub.calledOnce, 'InstancesClient.insert should be called once');
        const callArgs = insertStub.firstCall.args[0];
        const startupScript = callArgs.instanceResource.metadata.items.find(item => item.key === 'startup-script').value;
        assert(startupScript.includes('ollama pull test-model'), 'Custom modelName "test-model" not found in startup script');
        assert.strictEqual(callArgs.zone, 'custom-zone', 'Zone should be custom-zone');
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
    });

    it('Test 3: Initial metadata timestamps', async () => {
        mockReq = { body: {} };
        const beforeTimestamp = new Date(Date.now() - 1000).toISOString(); // Account for slight delay
        await createInstanceHTTP(mockReq, mockRes);
        const afterTimestamp = new Date(Date.now() + 1000).toISOString();


        assert(insertStub.calledOnce, 'InstancesClient.insert should be called once');
        const metadataItems = insertStub.firstCall.args[0].instanceResource.metadata.items;
        
        const startupTimestampItem = metadataItems.find(item => item.key === 'startup-timestamp');
        assert(startupTimestampItem, 'startup-timestamp metadata item not found');
        assert(startupTimestampItem.value >= beforeTimestamp && startupTimestampItem.value <= afterTimestamp, 'startup-timestamp is not a recent ISO string');

        const lastActivityTimestampItem = metadataItems.find(item => item.key === 'last-activity-timestamp');
        assert(lastActivityTimestampItem, 'last-activity-timestamp metadata item not found');
        assert(lastActivityTimestampItem.value >= beforeTimestamp && lastActivityTimestampItem.value <= afterTimestamp, 'last-activity-timestamp is not a recent ISO string');
        assert.strictEqual(startupTimestampItem.value, lastActivityTimestampItem.value, 'startup-timestamp and last-activity-timestamp should initially be the same');
        
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
    });
    
    it('Should return 500 if GCLOUD_PROJECT is not set', async () => {
        delete process.env.GCLOUD_PROJECT; // Undefine GCLOUD_PROJECT
        
        // Re-require the function to pick up the changed env var
        delete require.cache[require.resolve('../functions/createInstance.js')];
        require('../functions/createInstance.js');
        createInstanceHTTP = functionsFramework.getFunction('createInstance');
         if (!createInstanceHTTP) {
            const createInstanceModule = require('../functions/createInstance.js');
            createInstanceHTTP = createInstanceModule.createInstance;
        }


        mockReq = { body: {} };
        await createInstanceHTTP(mockReq, mockRes);

        assert(mockRes.status.calledWith(500), 'Response status should be 500');
        assert(mockRes.send.calledWith('Server configuration error: GCLOUD_PROJECT not set.'), 'Correct error message not sent');
        assert(insertStub.notCalled, 'InstancesClient.insert should not be called');
    });
});

// Note: Stubbing new InstancesClient() can be tricky.
// If InstancesClient.prototype.insert doesn't work, one might need to use proxyquire or similar
// to inject a mock for the entire '@google-cloud/compute' module.
// For example:
// const compute = { InstancesClient: function() { return mockInstancesClient; } };
// const { createInstance } = proxyquire('../functions/createInstance', { '@google-cloud/compute': compute });
// This test assumes that `functionsFramework.getFunction('createInstance')` correctly retrieves
// the HTTP handler, and that `require('../functions/createInstance.js')` makes the function register itself.
// The explicit export `module.exports.createInstance = createInstanceHTTP;` in the function file helps.
// It also directly stubs the methods on the prototype of InstancesClient.
// This should generally work if the client methods are called on `new InstancesClient().method()`.
// If the stubs `sinon.stub(InstancesClient.prototype, 'insert')` are not working,
// it means the `InstancesClient` is not being instantiated as expected or the module loading
// is bypassing the prototype stub.
// A more robust way would be to pass the client as a dependency to the function if possible,
// or use a library like `proxyquire` for deeper mocking.
// The current setup tries to re-require the function after mocks are set up.
// The current stubs for InstancesClient.prototype.insert and .get are applied globally to the prototype.
// This is a common pattern but can be fragile if the module system or class usage is complex.
// The `delete require.cache` and re-`require` is an attempt to ensure the function sees the stubbed environment.I've created `tests/test_createInstance.js` in the previous turn.

Now, I'll create `tests/test_getInstanceStatus.js` and write tests for the `getInstanceStatus` function.
I will:
1.  Require necessary modules (`assert`, `sinon`).
2.  Mock `@google-cloud/compute`'s `InstancesClient`.
3.  Mock `process.env`.
4.  Write the test cases as described in the prompt for `getInstanceStatus`.
