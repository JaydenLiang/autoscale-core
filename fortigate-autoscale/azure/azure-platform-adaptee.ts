import { ComputeManagementClient } from '@azure/arm-compute';
import { VirtualMachineScaleSetVM } from '@azure/arm-compute/esm/models';
import { NetworkManagementClient } from '@azure/arm-network';
import { NetworkInterface } from '@azure/arm-network/esm/models';
import {
    CosmosClient,
    CosmosClientOptions,
    Database,
    FeedResponse,
    RequestOptions,
    SqlParameter,
    SqlQuerySpec
} from '@azure/cosmos';
import * as msRestNodeAuth from '@azure/ms-rest-nodeauth';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import fs from 'fs';
import * as HttpStatusCodes from 'http-status-codes';
import path from 'path';

import { SettingItem, Settings } from '../../autoscale-setting';
import { Blob } from '../../blob';
import {
    DbDeleteError,
    DbErrorCode,
    DbReadError,
    DbSaveError,
    KeyValue,
    SaveCondition,
    Table
} from '../../db-definitions';
import { PlatformAdaptee } from '../../platform-adaptee';
import {
    AzureApiRequestCache,
    AzureSettings,
    AzureSettingsDbItem,
    CosmosDBQueryResult,
    CosmosDBQueryWhereClause,
    CosmosDbTableMetaData
} from './azure-db-definitions';
import { AzureFortiGateAutoscaleSetting } from './azure-fortigate-autoscale-settings';

export enum requiredEnvVars {
    AUTOSCALE_DB_ACCOUNT = 'AUTOSCALE_DB_ACCOUNT',
    AUTOSCALE_DB_NAME = 'AUTOSCALE_DB_NAME',
    AZURE_STORAGE_ACCOUNT = 'AZURE_STORAGE_ACCOUNT',
    AZURE_STORAGE_ACCESS_KEY = 'AZURE_STORAGE_ACCESS_KEY',
    RESOURCE_TAG_PREFIX = 'RESOURCE_TAG_PREFIX',
    REST_APP_ID = 'REST_APP_ID',
    REST_APP_SECRET = 'REST_APP_SECRET',
    SUBSCRIPTION_ID = 'SUBSCRIPTION_ID',
    TENANT_ID = 'TENANT_ID'
}

export interface ApiCacheRequest {
    api: string;
    parameters: string[];
    ttl?: number;
}

export interface ApiCacheResult {
    id?: string;
    api?: string;
    parameters?: string[];
    stringifiedData: string;
    ttl: number;
    cacheTime?: number;
}

export interface ApiCache<T> {
    result: T;
    hitCache: boolean;
    cacheTime: number;
    ttl: number;
}

/**
 * Api Cache options
 * @enum
 */
export enum ApiCacheOption {
    /**
     * @member {string} ReadApiFirst always request data from api then save data to cache.
     */
    ReadApiFirst = 'ReadApiFirst',
    /**
     * @member {string} ReadApiOnly always request data from api but never save data to cache.
     */
    ReadApiOnly = 'ReadApiOnly',
    /**
     * @member {string} ReadCacheAndDelete read cache, delete the cache. not request data from api
     */
    ReadCacheAndDelete = 'ReadCacheAndDelete',
    /**
     * @member {string} ReadCacheFirst read cache first. if no cached data, request data from api
     * then save data to cache.
     */
    ReadCacheFirst = 'ReadCacheFirst',
    /**
     * @member {string} ReadCacheOnly only read data from cache. not request data from api
     */
    ReadCacheOnly = 'ReadCacheOnly'
}

export class AzurePlatformAdaptee implements PlatformAdaptee {
    protected autoscaleDBRef: Database;
    protected azureCompute: ComputeManagementClient;
    protected azureCosmosDB: CosmosClient;
    protected azureNetwork: NetworkManagementClient;
    protected azureStorage: BlobServiceClient;
    protected settings: Settings;
    /**
     * The following process.env are required.
     * process.env.AUTOSCALE_DB_ACCOUNT: the CosmosDB account name
     * process.env.AUTOSCALE_DB_NAME: the Autoscale db name.
     * process.env.REST_APP_ID: the App registration (service principal) app client_id.
     * process.env.REST_APP_SECRET: the App registration (service principal) app client_secret.
     * process.env.TENANT_ID: the tenant containing the App registration (service principal) app.
     */
    constructor() {
        // validation
        const missingEnvVars = Object.keys({ ...requiredEnvVars }).filter(key => !process.env[key]);
        if (missingEnvVars.length > 0) {
            throw new Error(`Missing the following environment variables: ${missingEnvVars.join}.`);
        }
    }
    /**
     * Class instance initiation. The following process.env are required.
     * process.env.AUTOSCALE_DB_ACCOUNT: the CosmosDB account name
     * process.env.AUTOSCALE_DB_NAME: the Autoscale db name.
     * process.env.REST_APP_ID: the App registration (service principal) app client_id.
     * process.env.REST_APP_SECRET: the App registration (service principal) app client_secret.
     * process.env.TENANT_ID: the tenant containing the App registration (service principal) app.
     * @returns {Promise} void
     */
    async init(): Promise<void> {
        const cosmosClientOptions: CosmosClientOptions = {
            endpoint: `https://${process.env.AUTOSCALE_DB_ACCOUNT}.documents.azure.com/`,
            key: process.env.REST_API_MASTER_KEY
        };
        this.azureCosmosDB = new CosmosClient(cosmosClientOptions);
        this.autoscaleDBRef = this.azureCosmosDB.database(process.env.AUTOSCALE_DB_NAME);
        const creds = await msRestNodeAuth.loginWithServicePrincipalSecret(
            process.env.REST_APP_ID,
            process.env.REST_APP_SECRET,
            process.env.TENANT_ID
        );
        this.azureCompute = new ComputeManagementClient(creds, process.env.SUBSCRIPTION_ID);
        this.azureNetwork = new NetworkManagementClient(creds, process.env.SUBSCRIPTION_ID);
        this.azureStorage = new BlobServiceClient(
            `https://${process.env.AZURE_STORAGE_ACCOUNT}.blob.core.windows.net`,
            new StorageSharedKeyCredential(
                process.env.AZURE_STORAGE_ACCOUNT,
                process.env.AZURE_STORAGE_ACCESS_KEY
            )
        );
    }
    async loadSettings(): Promise<Settings> {
        if (this.settings) {
            return this.settings;
        }
        const table = new AzureSettings();
        const records: Map<string, AzureSettingsDbItem> = new Map();
        const queryResult: CosmosDBQueryResult<AzureSettingsDbItem> = await this.listItemFromDb<
            AzureSettingsDbItem
        >(table);
        queryResult.result.map(rec => [rec.settingKey, rec]);
        const settings: Settings = new Map<string, SettingItem>();
        Object.values(AzureFortiGateAutoscaleSetting).forEach(value => {
            if (records.has(value)) {
                const record = records.get(value);
                const settingItem = new SettingItem(
                    record.settingKey,
                    record.settingValue,
                    record.description,
                    record.editable,
                    record.jsonEncoded
                );
                settings.set(value, settingItem);
            }
        });
        this.settings = settings;
        return this.settings;
    }

    /**
     * get a single item.
     * @param  {Table<T>} table the instance of Table<T> to delete the item.
     * T is the db item type of the given table.
     * @param  {KeyValue[]} partitionKeys the partition keys (primary key)
     * of the table
     * @returns {Promise<T>} T
     */
    async getItemFromDb<T>(table: Table<T>, partitionKeys: KeyValue[]): Promise<T> {
        const primaryKey: KeyValue = partitionKeys[0];
        const itemResponse = await this.autoscaleDBRef
            .container(table.name)
            .item(primaryKey.value)
            .read();
        if (itemResponse.statusCode === HttpStatusCodes.OK) {
            return table.convertRecord({ ...itemResponse.resource });
        } else if (itemResponse.statusCode === HttpStatusCodes.NOT_FOUND) {
            throw new DbReadError(DbErrorCode.NotFound, 'item not found');
        } else {
            throw new DbReadError(DbErrorCode.UnexpectedResponse, JSON.stringify(itemResponse));
        }
    }

    /**
     * Scan and list all or some record from a given db table
     * @param  {Table<T>} table the instance of Table to list the item.
     * @param  {CosmosDBQueryWhereClause[]} listClause (optional) a filter for listing the records
     * @param  {number} limit (optional) number or records to return
     * @returns {Promise} CosmosDBQueryResult object with an array of db record
     * @see https://docs.microsoft.com/en-us/azure/cosmos-db/sql-query-select
     */
    async listItemFromDb<T>(
        table: Table<T>,
        listClause?: CosmosDBQueryWhereClause[],
        limit?: number
    ): Promise<CosmosDBQueryResult<T>> {
        const querySpec: SqlQuerySpec = {
            query: `SELECT * FROM ${table.name} t`
        };
        if (listClause && listClause.length > 0) {
            querySpec.query = `${querySpec.query} WHERE`;
            querySpec.parameters = listClause.map(clause => {
                querySpec.query = `${querySpec.query} t.${clause.name} = @${clause.name} AND`;
                return {
                    name: `@${clause.name}`,
                    value: clause.value
                } as SqlParameter;
            });
            // to remove the last ' AND'
            querySpec.query = querySpec.query.substr(0, querySpec.query.length - 4);
        }
        if (limit && limit > 0) {
            querySpec.query = `${querySpec.query} LIMIT ${limit}`;
        }
        const queryResult: CosmosDBQueryResult<T> = {
            query: querySpec.query,
            result: null
        };
        const feeds: FeedResponse<T> = await this.autoscaleDBRef
            .container(table.name)
            .items.query<T>(querySpec)
            .fetchAll();
        queryResult.result = feeds.resources;
        return queryResult;
    }
    /**
     * save an item to db
     * @param  {Table<T>} table the instance of Table to save the item.
     * @param  {T} item the item to save
     * @param  {SaveCondition} condition save condition
     * @param  {boolean} ensureDataConsistency? ensure data consistency to prevent saving outdated data
     * @returns {Promise<T>} a promise of item of type T
     */
    async saveItemToDb<T extends CosmosDbTableMetaData>(
        table: Table<T>,
        item: T,
        condition: SaveCondition,
        ensureDataConsistency = true
    ): Promise<T> {
        // CAUTION: validate the db input (non meta data)
        table.validateInput<T>(item);
        // read the item
        const itemSnapshot = await this.getItemFromDb(table, [
            {
                key: table.primaryKey.name,
                value: item.id
            }
        ]);
        // NOTE: if ensureDataConsistency, enforces this access condition
        const options: RequestOptions = ensureDataConsistency && {
            accessCondition: {
                type: 'IfMatch',
                condition: itemSnapshot && itemSnapshot._etag
            }
        };
        // update only but no record found
        if (condition === SaveCondition.UpdateOnly && !itemSnapshot) {
            throw new DbSaveError(
                DbErrorCode.NotFound,
                `Unable to update the item (id: ${item.id}).` +
                    ` The item not exists in the table (name: ${table.name}).`
            );
        }
        // insert only but record found
        else if (condition === SaveCondition.InsertOnly && itemSnapshot) {
            throw new DbSaveError(
                DbErrorCode.KeyConflict,
                `Unable to insert the item (id: ${item.id}).` +
                    ` The item already exists in the table (name: ${table.name}).`
            );
        }
        if (
            ensureDataConsistency &&
            itemSnapshot &&
            item[table.primaryKey.name] !== itemSnapshot[table.primaryKey.name]
        ) {
            throw new DbSaveError(
                DbErrorCode.InconsistentData,
                'Inconsistent data.' +
                    ' Primary key values not match.' +
                    'Cannot save item back into db due to' +
                    ' the restriction parameter ensureDataConsistency is set to: true.'
            );
        }
        // ASSERT: input validation and data consistency checking have passed.
        // db item meta data properties except for the 'id' do not need to be present so they
        // will be removed from the object
        const saveItem = { ...item };
        // CAUTION: id accepts non-empty string value
        // will try to set the id when present in the item,
        // otherwise, will always set id to the same value as primary key
        saveItem.id =
            ((item.id || Number(item.id) === 0) && item.id) || String(item[table.primaryKey.name]);
        delete saveItem._attachments;
        delete saveItem._etag;
        delete saveItem._rid;
        delete saveItem._self;
        delete saveItem._ts;

        // update or insert
        const result = await this.autoscaleDBRef
            .container(table.name)
            .items.upsert(saveItem, options);
        if (
            result.statusCode === HttpStatusCodes.OK ||
            result.statusCode === HttpStatusCodes.CREATED
        ) {
            if (!result.resource) {
                throw new DbSaveError(
                    DbErrorCode.UnexpectedResponse,
                    "Upsert doesn't return expected data. see the detailed upsert " +
                        `result:${JSON.stringify(result)}`
                );
            }
            return table.convertRecord(result.resource);
        } else {
            throw new DbSaveError(
                DbErrorCode.UnexpectedResponse,
                'Saving item unsuccessfull. SDK returned unexpected response with ' +
                    ` httpStatusCode: ${result.statusCode}.`
            );
        }
    }
    /**
     * Delete a given item from the db
     * @param  {Table<T>} table the instance of Table to save the item.
     * @param  {T} item the item to be deleted. The primary key must be presented for deletion.
     * @param  {boolean} ensureDataConsistency ensure data consistency to prevent deleting outdated
     * data by doing a full-match of properties of the given item against the item in the db. In
     * this case, each property including meta data will be compared. Otherwise, only the primary
     * key will be used for deletion.
     * @returns {Promise<void>} a promise of void
     */
    async deleteItemFromDb<T extends CosmosDbTableMetaData>(
        table: Table<T>,
        item: T,
        ensureDataConsistency = true
    ): Promise<void> {
        let itemSnapshot: T;
        // read the item for comparison if rrequire ensureDataConsistency
        if (ensureDataConsistency) {
            // CAUTION: validate the db input (non meta data)
            table.validateInput<T>(item);
            // read the item
            try {
                itemSnapshot = await this.getItemFromDb(table, [
                    {
                        key: table.primaryKey.name,
                        value: String(item[table.primaryKey.name])
                    }
                ]);
            } catch (error) {
                if (error instanceof DbReadError) {
                    throw new DbDeleteError(
                        DbErrorCode.NotFound,
                        'Cannot delete item. ' +
                            `Item (id: ${item.id}) not found in table (name: ${table.name}).`
                    );
                } else {
                    throw error;
                }
            }
            // full match
            const keyDiff = Object.keys(itemSnapshot).filter(
                key => itemSnapshot[key] !== item[key]
            );
            if (keyDiff.length > 0) {
                throw new DbDeleteError(
                    DbErrorCode.InconsistentData,
                    `Inconsistent data. The attributes don't match: ${keyDiff.join()}. ` +
                        ` Item to delete: ${JSON.stringify(item)}.` +
                        ` Item in the db: ${JSON.stringify(itemSnapshot)}.`
                );
            }
        }
        // CAUTION: validate the db input (only primary key)
        if (item[table.primaryKey.name] === null) {
            throw new DbDeleteError(
                DbErrorCode.InconsistentData,
                `Required primary key attribute: ${table.primaryKey.name} not` +
                    ` found in item: ${JSON.stringify(item)}`
            );
        }
        // ASSERT: the id and primary key should have the same value
        if (item.id !== item[table.primaryKey.name]) {
            throw new DbDeleteError(
                DbErrorCode.InconsistentData,
                "Item primary key value and id value don't match. Make sure the id" +
                    ' and primary key have the same value.'
            );
        }
        // ASSERT: the given item matches the item in the db. It can be now deleted.
        const deleteResponse = await this.autoscaleDBRef
            .container(table.name)
            .item(item.id)
            .delete();
        if (deleteResponse.statusCode === HttpStatusCodes.OK) {
            return;
        } else if (deleteResponse.statusCode === HttpStatusCodes.NOT_FOUND) {
            throw new DbDeleteError(
                DbErrorCode.NotFound,
                `Item (${table.primaryKey.name}: ` +
                    `${item.id}) not found in table (${table.name})`
            );
        } else {
            throw new DbDeleteError(
                DbErrorCode.UnexpectedResponse,
                'Deletion unsuccessful. SDK returned unexpected response with ' +
                    ` httpStatusCode: ${deleteResponse.statusCode}.`
            );
        }
    }
    private generateCacheId(api: string, parameters: string[]): string {
        // NOTE: id is constructed as <api>-[<parameter1-value>-,[<parameter2-value>-...]]
        return [api, ...parameters.map(String)].join('-');
    }
    /**
     * read a cached response of an API request
     * @param  {ApiCacheRequest} req the api request
     * @returns {Promise} ApiRequestSave
     */
    async apiRequestReadCache(req: ApiCacheRequest): Promise<ApiCacheResult> {
        const table = new AzureApiRequestCache();
        const item = await this.getItemFromDb(table, [
            {
                key: table.primaryKey.name,
                value: this.generateCacheId(req.api, req.parameters)
            }
        ]);
        if (item) {
            const timeToLive: number = req.ttl || item.ttl;
            if (item.cacheTime + timeToLive * 1000 > Date.now()) {
                return {
                    id: item.id,
                    stringifiedData: item.res,
                    ttl: item.ttl,
                    cacheTime: item.cacheTime
                };
            }
        }
        return null;
    }

    async apiRequestDeleteCache(req: ApiCacheRequest): Promise<void> {
        const table = new AzureApiRequestCache();
        const item = table.downcast({
            id: this.generateCacheId(req.api, req.parameters),
            res: null,
            cacheTime: null,
            ttl: null
        });
        await this.deleteItemFromDb<typeof item>(table, item, false);
    }

    /**
     * save a response of an API request to cache
     * @param  {ApiCacheResult} res the api response
     * @returns {Promise} ApiRequestSave
     */
    async apiRequestSaveCache(res: ApiCacheResult): Promise<ApiCacheResult> {
        // if neither of these conditions is met
        // 1. there is res.id
        // 2. there are res.api and res.parameters
        if (!(res.id || (!res.id && res.api && res.parameters))) {
            throw new Error('Invalid cache result to save. id, api, and paramters are required.');
        }
        const table = new AzureApiRequestCache();
        const item = table.downcast({
            id: res.id || this.generateCacheId(res.api, res.parameters),
            res: res.stringifiedData,
            cacheTime: undefined, // NOTE: cacheTime will use the value of _ts (db generated)
            ttl: res.ttl * 1000
        });
        const savedItem = await this.saveItemToDb<typeof item>(
            table,
            item,
            SaveCondition.Upsert,
            false
        );
        if (savedItem) {
            res.cacheTime = savedItem.cacheTime;
        }
        return res;
    }
    /**
     * send an api request with appling a caching strategy.
     * This can prevent from firing too many arm resource requests to Microsoft Azure that
     * results in throttling resource manager request.
     * @see https://docs.microsoft.com/en-us/azure/azure-resource-manager/management/request-limits-and-throttling
     * @param  {ApiCacheRequest} req an api cache request
     * @param  {ApiCacheOption} cacheOption option for the api caching behavior.
     * @param  {function} dataProcessor a method that process the api request and return
     * a promise of type D
     * @returns {Promise} an ApiCache of type D
     */
    private async requestWithCaching<D>(
        req: ApiCacheRequest,
        cacheOption: ApiCacheOption,
        dataProcessor: () => Promise<D>
    ): Promise<ApiCache<D>> {
        const ttl = 600;
        let cacheTime: number;
        let res: ApiCacheResult;
        let data: D;

        // read cache for those options require reading cache
        if (cacheOption !== ApiCacheOption.ReadApiOnly) {
            res = await this.apiRequestReadCache(req);
            cacheTime = res && res.cacheTime;
            data = (res && JSON.parse(res.stringifiedData)) || [];
        }

        const hitCache = !!res;

        // for those options do not require reading data from api
        if (
            cacheOption === ApiCacheOption.ReadCacheOnly ||
            cacheOption === ApiCacheOption.ReadCacheAndDelete
        ) {
            // delete the cache if exists
            if (cacheOption === ApiCacheOption.ReadCacheAndDelete && res) {
                await this.apiRequestDeleteCache(req);
                cacheTime = 0;
                data = null;
            }
        }
        // for those options require reading data from api
        else {
            if (
                // read cache first then read api when cache not found
                (cacheOption === ApiCacheOption.ReadCacheFirst && !res) ||
                // read data from api only
                cacheOption === ApiCacheOption.ReadApiOnly
            ) {
                // read data from api
                data = await dataProcessor();
                if (data) {
                    // if it requires to save cache, save cache.
                    if (cacheOption === ApiCacheOption.ReadCacheFirst) {
                        res.api = req.api;
                        res.parameters = req.parameters;
                        res.stringifiedData = JSON.stringify(data);
                        res.ttl = req.ttl;
                        res = await this.apiRequestSaveCache(res);
                        cacheTime = res.cacheTime;
                    }
                }
            }
        }
        return {
            result: data,
            cacheTime: cacheTime,
            ttl: ttl,
            hitCache: hitCache
        };
    }

    /**
     * list vm instances in the given scaling group (vmss)
     * @param  {string} scalingGroupName the scaling group containing the vm
     * @param  {ApiCacheOption} cacheOption (optional) option for the api caching behavior.
     * default to ApiCacheOption.ReadCacheFirst
     * @returns {Promise} a list of VirtualMachineScaleSetVM objects
     */
    async listInstances(
        scalingGroupName: string,
        cacheOption: ApiCacheOption = ApiCacheOption.ReadCacheFirst
    ): Promise<ApiCache<VirtualMachineScaleSetVM[]>> {
        const req: ApiCacheRequest = {
            api: 'listInstances',
            parameters: [scalingGroupName],
            ttl: 600 // expected time to live
        };

        const requestProcessor = async (): Promise<VirtualMachineScaleSetVM[]> => {
            const response = await this.azureCompute.virtualMachineScaleSetVMs.list(
                process.env[requiredEnvVars.RESOURCE_TAG_PREFIX],
                scalingGroupName
            );
            return (response && response._response.parsedBody) || null;
        };
        return await this.requestWithCaching<VirtualMachineScaleSetVM[]>(
            req,
            cacheOption,
            requestProcessor
        );
    }
    /**
     * describe a virtual machine
     * @param  {string} scalingGroupName the scaling group containing the vm
     * @param  {string} id the id (either integer instanceId or string vmId) of the vm
     * @param  {ApiCacheOption} cacheOption (optional) option for the api caching behavior.
     * default to ApiCacheOption.ReadCacheFirst
     * @returns {Promise} ApiCache<VirtualMachineScaleSetVM>
     */
    async describeInstance(
        scalingGroupName: string,
        id: string,
        cacheOption: ApiCacheOption = ApiCacheOption.ReadCacheFirst
    ): Promise<ApiCache<VirtualMachineScaleSetVM>> {
        let data: VirtualMachineScaleSetVM;
        // if id is an integer number, will infer an instanceId to be looked up
        if (isFinite(Number(id))) {
            const req: ApiCacheRequest = {
                api: 'describeInstance',
                parameters: [scalingGroupName, id],
                ttl: 600 // expected time to live
            };
            const requestProcessor = async (): Promise<typeof data> => {
                const response = await this.azureCompute.virtualMachineScaleSetVMs.get(
                    process.env[requiredEnvVars.RESOURCE_TAG_PREFIX],
                    scalingGroupName,
                    id,
                    {
                        expand: 'instanceView'
                    }
                );
                return response;
            };
            return await this.requestWithCaching<typeof data>(req, cacheOption, requestProcessor);
        }
        // ASSERT: id is the vmId to be looked up
        else {
            const listResult = await this.listInstances(scalingGroupName, cacheOption);
            data = listResult.result.find(v => v.vmId && v.vmId === id);
            return {
                result: data,
                cacheTime: listResult.cacheTime,
                ttl: listResult.ttl,
                hitCache: listResult.hitCache
            };
        }
    }
    /**
     * Delete an instance from a scaling group (vmss)
     * @param  {string} scalingGroupName the scaling group containing the vm
     * @param  {number} instanceId the integer instanceId of the vm
     * @returns {Promise} void
     */
    deleteInstanceFromVmss(scalingGroupName: string, instanceId: number): Promise<void> {
        throw new Error('Method not implemented.');
        return null;
    }
    /**
     * list network interfaces of a vm in the scaling group (vmss)
     * @param  {string} scalingGroupName the scaling group containing the vm
     * @param  {number} id the integer instanceId of the vm
     * @param  {ApiCacheOption} cacheOption (optional) option for the api caching behavior.
     * default to ApiCacheOption.ReadCacheFirst
     * @param  {number} ttl (optional) cache time to live in seconds. default to 600
     * @returns {Promise} ApiCache<NetworkInterface[]>
     */
    async listNetworkInterfaces(
        scalingGroupName: string,
        id: number,
        cacheOption: ApiCacheOption = ApiCacheOption.ReadCacheFirst,
        ttl = 600
    ): Promise<ApiCache<NetworkInterface[]>> {
        const req: ApiCacheRequest = {
            api: 'listNetworkInterfaces',
            parameters: [scalingGroupName, String(id)],
            ttl: ttl // expected time to live
        };
        const requestProcessor = async (): Promise<NetworkInterface[]> => {
            const response = await this.azureNetwork.networkInterfaces.listVirtualMachineScaleSetVMNetworkInterfaces(
                process.env[requiredEnvVars.RESOURCE_TAG_PREFIX],
                scalingGroupName,
                String(id)
            );
            return (response && response._response.parsedBody) || null;
        };
        return await this.requestWithCaching<NetworkInterface[]>(
            req,
            cacheOption,
            requestProcessor
        );
    }

    private streamToBuffer(readableStream: NodeJS.ReadableStream): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks = [];
            readableStream.on('data', data => {
                chunks.push(data instanceof Buffer ? data : Buffer.from(data));
            });
            readableStream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            readableStream.on('error', reject);
        });
    }
    /**
     * read the content of a blob into a string
     * @param  {string} container the blob container containing the target blob file
     * @param  {string} blobFilePath the full path to the blob file in the container, including
     * blob file name
     * @returns {Promise} string
     */
    async getBlobContent(container: string, blobFilePath: string): Promise<string> {
        const containerClient = this.azureStorage.getContainerClient(container);
        if (!containerClient.exists()) {
            throw new Error(`blob container (name: ${container}) not exists.`);
        }
        const blobClient = containerClient.getBlobClient(blobFilePath);
        if (!blobClient.exists()) {
            throw new Error(`blob container (name: ${container}) not exists.`);
        }
        // download the blob from position 0 (beginning)
        const response = await blobClient.download();
        const buffer = await this.streamToBuffer(response.readableStreamBody);
        return buffer.toString();
    }
    /**
     * List all blob objects in a given container
     * @param  {string} container the blob container containing the target blob file
     * @param  {string} subdirectory the subdirectory of the container to list
     * @returns {Promise} an array of blob objects in the given location
     */
    async listBlob(container: string, subdirectory?: string): Promise<Blob[]> {
        let prefix = subdirectory || '';
        if (prefix && !prefix.endsWith('/')) {
            prefix = `${subdirectory}/`;
        }
        prefix = subdirectory.endsWith('/') ? subdirectory : `${subdirectory}/`;

        // DEBUG: for local debugging use, the next lines get files from local file system instead
        // it is usually useful when doing a mock test that do not require real api calls
        if (process.env.LOCAL_DEV_MODE === 'true') {
            return fs
                .readdirSync(path.resolve(container, prefix))
                .filter(fileName => {
                    const stat = fs.statSync(path.resolve(container, prefix, fileName));
                    return !stat.isDirectory();
                })
                .map(fileName => {
                    return {
                        fileName: fileName,
                        content: ''
                    } as Blob;
                });
        } else {
            const containerClient = this.azureStorage.getContainerClient(container);
            if (!containerClient.exists()) {
                throw new Error(`blob container (name: ${container}) not exists.`);
            }
            const iterator = containerClient.listBlobsFlat();
            const blobs: Blob[] = [];
            let result = await iterator.next();
            while (!result.done) {
                blobs.push({
                    fileName: path.basename(result.value.name),
                    filePath: path.dirname(result.value.name)
                });
                result = await iterator.next();
            }
            return blobs.filter(blob => blob.filePath === subdirectory);
        }
    }
}
