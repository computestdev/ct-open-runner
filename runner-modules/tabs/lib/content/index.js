'use strict';
/* global window:false */
const EventEmitter = require('events').EventEmitter;

const ContentRPC = require('../../../../lib/contentRpc/ContentRPC');
const tabsMethods = require('./tabsMethods');
const {setupLogging} = require('./logging');
const logger = require('../../../../lib/logger');
const contentUnloadEvent = require('./contentUnloadEvent');
const ModuleRegister = require('../../../../lib/ModuleRegister');
const tabsModule = require('./tabsModule');

const log = logger({hostname: 'content', MODULE: 'tabs/content/index'});
// Firefox 66 has a rare bug in which the content script sometimes executes 2 times, in separate sandboxes.
// Both of these scripts then remain active and will respond to RPC commands.
// This token is used to filter out messages that are not meant for this instance of the content script.
const contentToken = `${Date.now()}x${window.crypto.getRandomValues(new Uint32Array(1))[0]}`;
const logHandler = setupLogging(browser.runtime, contentToken);

try {
    if (window.openRunnerRegisterRunnerModule) {
        throw Error('This tab has already had its content initialized!');
    }

    const moduleRegister = new ModuleRegister();
    // getModule is similar to include() in the other scopes, however it only supports modules which have already
    // been loaded (or are in the progress of loading)
    const getModule = name => moduleRegister.waitForModuleRegistration(name);
    const eventEmitter = new EventEmitter();
    const fireContentUnload = contentUnloadEvent(eventEmitter);
    const getScriptApiVersion = () => scriptApiVersionPromise;

    const contentUnload = () => {
        log.debug('Received tabs.contentUnload from background');
        fireContentUnload();
    };

    const rpc = new ContentRPC({
        browserRuntime: browser.runtime,
        context: 'runner-modules/tabs',
        contentToken,
    });
    rpc.attach();
    rpc.methods(tabsMethods(moduleRegister, eventEmitter, getScriptApiVersion));
    rpc.method('tabs.contentUnload', contentUnload);
    window.addEventListener('unload', fireContentUnload);
    eventEmitter.on('tabs.contentUnload', () => log.debug('Content is about to unload'));

    eventEmitter.on('tabs.contentUnload', () => {
        // eslint-disable-next-line camelcase, no-undef
        const myCoverage = typeof __runner_coverage__ === 'object' && __runner_coverage__;
        /* istanbul ignore else */
        if (myCoverage) {
            rpc.callAndForget('core.submitCodeCoverage', myCoverage);
        }
    });

    const openRunnerRegisterRunnerModule = async (moduleName, func) => {
        try {
            if (typeof func !== 'function') {
                throw Error('openRunnerRegisterRunnerModule(): Invalid `func`');
            }

            const scriptApiVersion = await getScriptApiVersion();
            const initModule = async () => {
                return await func({
                    eventEmitter,
                    getModule,
                    rpc,
                    scriptApiVersion,
                });
            };

            const promise = initModule();
            moduleRegister.registerModule(moduleName, promise);

            log.debug({moduleName}, 'Runner module has been initialized. Notifying the background script');
            await rpc.call('tabs.contentInit', {moduleName});
        }
        catch (err) {
            log.error({err}, 'Error during openRunnerRegisterRunnerModule()');
            throw err;
        }
    };
    openRunnerRegisterRunnerModule.defaultLogHandler = logHandler;
    Object.freeze(openRunnerRegisterRunnerModule);

    const handleWindowMessage = event => {
        // Note!! These messages could come from anywhere (the web)!
        const {data} = event;
        if (typeof data !== 'object') {
            return;
        }

        const {openrunnerTabsFrameToken} = data;

        if (typeof openrunnerTabsFrameToken !== 'string' || Object.keys(data).length !== 1) {
            return;
        }

        const frameToken = String(openrunnerTabsFrameToken);
        event.stopImmediatePropagation();
        log.debug({frameToken}, 'Received frame token from parent frame');
        rpc.callAndForget('tabs.receivedFrameToken', frameToken);
    };

    moduleRegister.registerModule('tabs', Promise.resolve(tabsModule({eventEmitter, getModule, rpc})));

    window.openRunnerRegisterRunnerModule = openRunnerRegisterRunnerModule;
    window.addEventListener('message', handleWindowMessage, false);
    // Workaround for firefox bug (last tested to occur in v57 and v65)
    // it seems that sometimes this content script is executed so early that firefox still has to perform some kind of house keeping,
    // which causes our global variable to disappear. assigning the global variable again in a microtask works around this bug.
    Promise.resolve().then(() => {
        window.openRunnerRegisterRunnerModule = openRunnerRegisterRunnerModule;
    });
    window.addEventListener('openrunnerinitmoduleframework', e => {
        e.stopImmediatePropagation();
        window.openRunnerRegisterRunnerModule = openRunnerRegisterRunnerModule;
    });


    log.debug('Initialized... Notifying the background script');
    const backgroundScriptInitDataPromise = rpc.call('tabs.mainContentInit').then(data => {
        log.debug({data}, 'Received init data from background');
        return data;

    }).catch(err => {
        log.error({err}, 'Error calling tabs.mainContentInit');
        throw err;
    });
    const scriptApiVersionPromise = backgroundScriptInitDataPromise.then(data => data.scriptApiVersion);
}
catch (err) {
    log.error({err}, 'Error during initialization');
}
