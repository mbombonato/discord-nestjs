import { Injectable } from '@nestjs/common';
import { GuardResolver } from './guard.resolver';
import { ReflectMetadataProvider } from '../provider/reflect-metadata.provider';
import { DiscordService } from '../service/discord.service';
import { DiscordHandlerService } from '../service/discord-handler.service';
import { DiscordAccessService } from '../service/discord-access.service';
import { MiddlewareResolver } from './middleware.resolver';
import { PipeResolver } from './pipe.resolver';
import { ParamResolver } from './param.resolver';
import { MethodResolveOptions } from './interface/method-resolve-options';
import { ClientEvents, Message } from 'discord.js';
import { MethodResolver } from './interface/method-resolver';
import { ValidationError } from 'class-validator';
import { ValidationProvider } from '../provider/validation.provider';

@Injectable()
export class OnceEventResolver implements MethodResolver {
  constructor(
    private readonly guardResolver: GuardResolver,
    private readonly metadataProvider: ReflectMetadataProvider,
    private readonly discordService: DiscordService,
    private readonly discordHandlerService: DiscordHandlerService,
    private readonly discordAccessService: DiscordAccessService,
    private readonly middlewareResolver: MiddlewareResolver,
    private readonly pipeResolver: PipeResolver,
    private readonly paramResolver: ParamResolver,
    private readonly validationProvider: ValidationProvider,
  ) {}

  resolve(options: MethodResolveOptions): void {
    const { instance, methodName } = options;
    const metadata = this.metadataProvider.getOnceMessageDecoratorMetadata(instance, methodName);
    if (!metadata) {
      return;
    }
    const {event} = metadata;
    this.discordService.getClient().once(event, async (...data: ClientEvents[keyof ClientEvents]) => {
      //#region check allow handle message
      if (!this.discordAccessService.isAllowGuild(data)) {
        return;
      }
      if (this.discordAccessService.isDenyGuild(data)) {
        return;
      }
      //#endregion

      //#region apply middleware, guard, pipe
      const context = data;
      await this.middlewareResolver.applyMiddleware(event, context);
      const isAllowFromGuards = await this.guardResolver.applyGuard({
        instance,
        methodName,
        event,
        context
      });
      if (!isAllowFromGuards) {
        return;
      }
      const paramType = this.paramResolver.getContentType({
        instance,
        methodName,
      });
      let message;
      if (event === 'message') {
        const messageContext: Message = context[0];
        let pipeMessageContent;
        try {
          pipeMessageContent = await this.pipeResolver.applyPipe({
            instance,
            methodName,
            event,
            context,
            content: messageContext.content,
            type: paramType
          });
        } catch (err) {
          if (err instanceof Array && err[0] instanceof ValidationError) {
            const messageEmbed = this.validationProvider.getErrorMessage() ??
              this.validationProvider.getDefaultErrorMessage(err, messageContext.content);
            await messageContext.reply(messageEmbed);
            return;
          }
          throw err;
        }
        message = pipeMessageContent ?? messageContext.content;
      }
      //#endregion

      const argsFromDecorator = this.paramResolver.applyParam({
        instance,
        methodName,
        context,
        content: message
      });
      const handlerArgs = argsFromDecorator ?? context;
      await this.discordHandlerService.callHandler(
        instance,
        methodName,
        handlerArgs
      );
    });
  }
}