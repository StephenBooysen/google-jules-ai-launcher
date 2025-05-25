const assert = require('assert');
const sinon = require('sinon');
const { InstancesClient } = require('@google-cloud/compute');
const functionsFramework = require('@google-cloud/functions-framework');

let getInstanceStatusHTTP;

describe('Cloud Function: getInstanceStatus', () => {
    let mockReq, mockRes;
    let getStub;
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.GCLOUD_PROJECT = 'test-project';
        process.env.DEFAULT_ZONE = 'test-default-zone';

        getStub = sinon.stub(); // To be configured per test

        // Stub the InstancesClient methods
        // Assuming 'new InstancesClient().get' is called
        sinon.stub(InstancesClient.prototype, 'get').callsFake(getStub);

        mockRes = {
            status: sinon.stub().returnsThis(),
            send: sinon.stub(),
            json: sinon.stub(), // for @google-cloud/functions-framework sending JSON
        };
        
        // Ensure fresh require for each test
        delete require.cache[require.resolve('../functions/getInstanceStatus.js')];
        require('../functions/getInstanceStatus.js');
        getInstanceStatusHTTP = functionsFramework.getFunction('getInstanceStatus');

        if (!getInstanceStatusHTTP) {
            const getInstanceStatusModule = require('../functions/getInstanceStatus.js');
            getInstanceStatusHTTP = getInstanceStatusModule.getInstanceStatus; 
        }
    });

    afterEach(() => {
        sinon.restore();
        process.env = originalEnv;
        delete require.cache[require.resolve('../functions/getInstanceStatus.js')];
    });

    it('Test 1: Correct API call with instanceName and zone', async () => {
        mockReq = { 
            query: { instanceName: 'my-instance', zone: 'custom-zone' } 
        };
        const mockInstanceData = { 
            name: 'my-instance', 
            status: 'RUNNING', 
            networkInterfaces: [{ name: 'nic0' }] 
        };
        getStub.resolves([mockInstanceData]);

        await getInstanceStatusHTTP(mockReq, mockRes);

        assert(getStub.calledOnce, 'InstancesClient.get should be called once');
        const callArgs = getStub.firstCall.args[0];
        assert.strictEqual(callArgs.project, 'test-project', 'Project ID should be test-project');
        assert.strictEqual(callArgs.zone, 'custom-zone', 'Zone should be custom-zone');
        assert.strictEqual(callArgs.instance, 'my-instance', 'Instance name should be my-instance');
        
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
        assert(mockRes.send.calledOnceWith(sinon.match({
            instanceName: 'my-instance',
            zone: 'custom-zone',
            status: 'RUNNING'
        })), 'Response data not as expected');
    });

    it('Test 1b: Correct API call with instanceName and default zone', async () => {
        mockReq = { 
            query: { instanceName: 'my-instance-default-zone' } 
        };
         const mockInstanceData = { 
            name: 'my-instance-default-zone', 
            status: 'TERMINATED', 
            networkInterfaces: [] 
        };
        getStub.resolves([mockInstanceData]);


        await getInstanceStatusHTTP(mockReq, mockRes);

        assert(getStub.calledOnce, 'InstancesClient.get should be called once');
        const callArgs = getStub.firstCall.args[0];
        assert.strictEqual(callArgs.project, 'test-project', 'Project ID should be test-project');
        assert.strictEqual(callArgs.zone, 'test-default-zone', 'Zone should be test-default-zone (default)');
        assert.strictEqual(callArgs.instance, 'my-instance-default-zone', 'Instance name should be my-instance-default-zone');
        
        assert(mockRes.status.calledWith(200), 'Response status should be 200');
         assert(mockRes.send.calledOnceWith(sinon.match({
            instanceName: 'my-instance-default-zone',
            zone: 'test-default-zone',
            status: 'TERMINATED'
        })), 'Response data not as expected for default zone');
    });

    it('Test 2: Missing instanceName in query', async () => {
        mockReq = { query: { zone: 'a-zone' } }; // instanceName is missing

        await getInstanceStatusHTTP(mockReq, mockRes);

        assert(getStub.notCalled, 'InstancesClient.get should not be called');
        assert(mockRes.status.calledWith(400), 'Response status should be 400 for missing instanceName');
        assert(mockRes.send.calledOnceWith(sinon.match({ message: 'Missing required query parameter: instanceName' })), 'Correct error message not sent for missing instanceName');
    });
    
    it('Should return 500 if GCLOUD_PROJECT is not set', async () => {
        delete process.env.GCLOUD_PROJECT;
        
        delete require.cache[require.resolve('../functions/getInstanceStatus.js')];
        require('../functions/getInstanceStatus.js');
        getInstanceStatusHTTP = functionsFramework.getFunction('getInstanceStatus');
         if (!getInstanceStatusHTTP) {
            const module = require('../functions/getInstanceStatus.js');
            getInstanceStatusHTTP = module.getInstanceStatus;
        }

        mockReq = { query: { instanceName: 'any-instance', zone: 'any-zone'} };
        await getInstanceStatusHTTP(mockReq, mockRes);

        assert(mockRes.status.calledWith(500), 'Response status should be 500');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Server configuration error: GCLOUD_PROJECT not set.'})), 'Correct error message not sent');
        assert(getStub.notCalled, 'InstancesClient.get should not be called');
    });

    it('Should return 404 if instance is not found (GCE API error code 5)', async () => {
        mockReq = { query: { instanceName: 'non-existent-instance', zone: 'a-zone'} };
        const notFoundError = new Error("Instance not found");
        notFoundError.code = 5; // GCE "NOT_FOUND" error code
        getStub.rejects(notFoundError);

        await getInstanceStatusHTTP(mockReq, mockRes);

        assert(getStub.calledOnce, 'InstancesClient.get should be called');
        assert(mockRes.status.calledWith(404), 'Response status should be 404 for instance not found');
        assert(mockRes.send.calledWith(sinon.match({ message: `Instance non-existent-instance not found in zone a-zone.` })), 'Correct error message not sent for instance not found');
    });

    it('Should return 500 for other GCE API errors', async () => {
        mockReq = { query: { instanceName: 'some-instance', zone: 'a-zone'} };
        const apiError = new Error("API limit exceeded");
        apiError.code = 8; // Example of another error code
        getStub.rejects(apiError);

        await getInstanceStatusHTTP(mockReq, mockRes);

        assert(getStub.calledOnce, 'InstancesClient.get should be called');
        assert(mockRes.status.calledWith(500), 'Response status should be 500 for other API errors');
        assert(mockRes.send.calledWith(sinon.match({ message: 'Error getting instance status' })), 'Correct error message not sent for other API errors');
    });
});
