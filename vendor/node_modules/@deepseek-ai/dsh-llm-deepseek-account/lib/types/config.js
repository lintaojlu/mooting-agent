import z from '@deepseek-ai/schemastery';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { catalogModelFields, deepSeekConfigFields, modelListingConfigFields, modelListingURL, resolveAdapterOptions, resolveListingTiming, } from '@deepseek-ai/dsh-llm-deepseek';
const { models: _protocolCatalog, ...protocolFields } = deepSeekConfigFields;
const modelOverride = z.object({
    ...catalogModelFields,
    // No default, unlike a models entry: an absent list materializes as [], which reads as inherited.
    inputModalities: z.array(z.union(['text', 'image'])),
});
export const Config = z.object({
    ...protocolFields,
    ...modelListingConfigFields,
    modelOverrides: z.dict(modelOverride).default({}).volatile(),
});
/**
 * Read the current value behind every reference of a validated Config.
 * @param config - parsed plugin Config.
 * @returns plain options for {@link resolveAccountOptions}.
 */
export function plainAccountOptions(config) {
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]));
}
/** Keep an override's declared fields: parsed configuration carries unset fields as `undefined` and unset arrays as `[]`. */
function resolveOverride(id, override) {
    if (id.length === 0)
        throw new Error('llm-deepseek-account: modelOverrides keys must be non-empty model ids');
    if (Object.hasOwn(override, 'id'))
        throw new Error(`llm-deepseek-account: modelOverrides.${id} sets "id", which is its key`);
    const declared = {};
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined || (Array.isArray(value) && value.length === 0))
            continue;
        Reflect.set(declared, key, value);
    }
    try {
        // Cross-field rules also involve the entry an override meets once a listing loads,
        // so an image-capable stand-in checks each declared field here.
        resolveAdapterOptions({ models: [{ inputModalities: ['text', 'image'], ...declared, id }] });
    }
    catch (error) {
        throw new Error(`llm-deepseek-account: modelOverrides.${id} is invalid: ${String(error)}`, { cause: error });
    }
    return declared;
}
/**
 * The one explicit resolve step from raw account settings to validated facts.
 * Settings updates can reach it without schema validation, so every bound is judged here.
 * @param options - plain account options.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns Messages settings, listing settings, and validated overrides.
 */
export function resolveAccountOptions(options, environment) {
    if (Object.hasOwn(options, 'models')) {
        throw new Error('llm-deepseek-account: models is no longer configurable; the account /models listing supplies the catalog. '
            + 'Remove models from this entry and adjust single models with modelOverrides.<model id>');
    }
    const { modelsTimeoutMs: _timeout, modelsMaxAgeMs: _maxAge, modelOverrides = {}, ...protocolOptions } = options;
    const timing = resolveListingTiming(options, 'llm-deepseek-account');
    const protocol = resolveAdapterOptions(protocolOptions, environment);
    return {
        protocol,
        catalog: { url: modelListingURL(protocol.baseURL), ...timing },
        modelOverrides: Object.fromEntries(Object.entries(modelOverrides).map(([id, override]) => [id, resolveOverride(id, override)])),
    };
}
//# sourceMappingURL=config.js.map