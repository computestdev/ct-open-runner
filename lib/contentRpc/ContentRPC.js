'use strict';
const MethodRegistrations = require('./MethodRegistrations');
const asyncTimeout = require('../asyncTimeout');
const errorToObject = require('../errorToObject');
const createRpcRequestError = require('./createRpcRequestError');
const log = require('../logger')({hostname: 'content', MODULE: 'ContentRPC'});
const {CONTENT_RPC_TIMEOUT_ERROR} = require('../scriptErrors');

const DEFAULT_CALL_TIMEOUT = 15004;

class ContentRPC {
    /**
     * @param {object} browserRuntime
     * @param {string} context
     * @param {string|null} [contentToken]
     *        Configure this RPC instance to only accept messages annotated with the given `contentToken`.
     *        And to annotate all outgoing messages with this `token`.
     *        The TabContentRPC instance at the other will automatically be configured with the same token.
     *        This feature can be used to ensure that we are talking to one specific instance of a content
     *        script, in case the content script gets executed multiple times.
     * @param {string} token
     */
    constructor({browserRuntime, context, contentToken = null}) {
        if (typeof context !== 'string' || !context) {
            throw Error('Invalid `context` argument');
        }

        if (!(
            contentToken === null ||
            (typeof contentToken === 'string' && contentToken)
        )) {
            throw Error('Invalid `contentToken` argument');
        }

        this.browserRuntime = browserRuntime;
        this.rpcContext = String(context);
        this.contentToken = contentToken;
        this._methods = new MethodRegistrations();
        this.handleRuntimeMessage = this.handleRuntimeMessage.bind(this);
        Object.freeze(this);
    }

    attach() {
        this.browserRuntime.onMessage.addListener(this.handleRuntimeMessage);
    }

    detach() {
        this.browserRuntime.onMessage.removeListener(this.handleRuntimeMessage);
    }

    handleRuntimeMessage(message, messageSender) {
        if (
            messageSender.id !== 'openrunner@computest.nl' || // different extension
            messageSender.tab || // message came from a content script (instead of the background script)
            !message ||
            message.rpcContext !== this.rpcContext || // incorrect context (e.g. scratchpad rpc vs runner-module rpc)
            (this.contentToken && message.rpcContentToken !== this.contentToken)
        ) {
            // undefined = Give other message handlers a chance to handle the message
            return undefined;
        }

        return Promise.resolve()
        .then(() => this._methods.call(message.method, ...message.params))
        .then(result => ({result}))
        .catch(err => ({error: errorToObject(err)}));
    }

    /**
     * Call the given remote method by name, (previously registered by the background script)
     * @param {string|Object} nameOrOptions The method name or an options object
     * @param {string} nameOrOptions.name The method name
     * @param {number} nameOrOptions.timeout A maximum time (in milliseconds) to wait for a response. The returned promise will reject
     *        after this time.
     * @param {...*} params
     * @return {*} The resolved value returned by the remote method.
     */
    async call(nameOrOptions, ...params) {
        if ((typeof nameOrOptions !== 'string' && typeof nameOrOptions !== 'object') || nameOrOptions === null) {
            throw Error('ContentRPC#call(): First argument must be a string or an object with at least a "name" property');
        }

        const name = typeof nameOrOptions === 'object' ? nameOrOptions.name : nameOrOptions;

        if (typeof name !== 'string') {
            throw Error('ContentRPC#call(): First argument must be a string or an object with at least a "name" property');
        }

        const timeout = typeof nameOrOptions === 'object' && 'timeout' in nameOrOptions
            ? nameOrOptions.timeout :
            DEFAULT_CALL_TIMEOUT;

        const message = {
            rpcContext: this.rpcContext,
            method: name,
            params,
        };

        if (this.contentToken) {
            message.rpcContentToken = this.contentToken;
        }

        // (A nice function name which we can easily recognise in stack traces)
        const contentRPC$call$sendMessage = async () => {
            try {
                return await this.browserRuntime.sendMessage('openrunner@computest.nl', message, {});
            }
            catch (err) {
                // note: errors thrown by the RPC method itself do not end up here, instead they end up in a "rejected" property
                // this way we can differentiate between errors raised by WebExt and our own RPC methods
                if (err.message === 'Could not establish connection. Receiving end does not exist.') {
                    // This could happen because:
                    // 1. The content script really did not attach a listener
                    // 2. The message was just sent to the content script, however the frame was in the process of navigating somewhere else
                    // and our content script on the next frame has not been loaded yet
                    const newError = Error(
                        `TabContentRPC: Remote Call "${name}" did not receive a response from the content script ` +
                        '(there are no listeners)',
                    );
                    newError.name = 'RPCNoResponse';
                    newError.cause = err;
                    throw newError;
                }

                throw err;
            }
        };

        const response = await asyncTimeout(
            contentRPC$call$sendMessage,
            {
                timeout,
                timeoutErrorName: CONTENT_RPC_TIMEOUT_ERROR,
                timeoutMessage: `ContentRPC: Remote Call "${name}" timed out after ${timeout}ms`,
            },
        )();

        if (!response) {
            const err = Error(`ContentRPC: Remote Call "${name}" did not receive a response from the background script`);
            err.name = 'RPCNoResponse';
            throw err;
        }

        if ('error' in response) {
            throw createRpcRequestError(response.error);
        }
        return response.result;
    }

    /**
     * Performs `this.call()`, however this method does not wait for the call to be fulfilled.
     * Any return value is ignored and rejections are logged.
     *
     * @param {string|Object} nameOrOptions
     * @param {string} nameOrOptions.name
     * @param {number} nameOrOptions.timeout
     * @param {...*} params
     */
    callAndForget(nameOrOptions, ...params) {
        this.call(nameOrOptions, ...params)
        .catch(err => log.error({err, methodName: nameOrOptions}, 'callAndForget: The remote method rejected with an error'));
    }

    methods(methods) {
        this._methods.registerAll(methods);
    }

    method(name, func) {
        this._methods.register(name, func);
    }
}

module.exports = ContentRPC;
