import { projectToolSchema } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
/** Executes visible capabilities directly and owns their complete batch settlement. */
export class NativeToolExecutor {
    maxParallel;
    pipeline;
    constructor(ctx, maxParallel = () => 10) {
        this.maxParallel = maxParallel;
        this.pipeline = new ToolExecutionPipeline(ctx);
    }
    describe(tools) {
        return { schemas: tools.map(definition => projectToolSchema(definition, false)) };
    }
    execute(input) {
        return executeToolBatch(input, this.pipeline, this.maxParallel);
    }
}
/** Cordis plugin name. */
export const name = 'native-tool-executor';
/** Tool registration and scoped dispatch. */
export const inject = ['tools'];
/**
 * Select native execution in the mounting scope.
 * @param ctx - context owning this executor's selection and lifetime.
 */
export function apply(ctx) {
    ctx.tools.setExecutor(new NativeToolExecutor(ctx));
}
//# sourceMappingURL=index.js.map