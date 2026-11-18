/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as auth_operatorEmail from "../auth/operatorEmail.js";
import type * as auth_otpMail from "../auth/otpMail.js";
import type * as auth_password from "../auth/password.js";
import type * as bytecodeGuard from "../bytecodeGuard.js";
import type * as chainActivations from "../chainActivations.js";
import type * as copier from "../copier.js";
import type * as copierStore from "../copierStore.js";
import type * as crons from "../crons.js";
import type * as destinations from "../destinations.js";
import type * as discovery from "../discovery.js";
import type * as encryption from "../encryption.js";
import type * as executionBlocks from "../executionBlocks.js";
import type * as gate from "../gate.js";
import type * as gitSync from "../gitSync.js";
import type * as http from "../http.js";
import type * as kora from "../kora.js";
import type * as licenses from "../licenses.js";
import type * as mail from "../mail.js";
import type * as mailAction from "../mailAction.js";
import type * as marketData from "../marketData.js";
import type * as news from "../news.js";
import type * as notifications from "../notifications.js";
import type * as operatorDefaults from "../operatorDefaults.js";
import type * as operatorEmails from "../operatorEmails.js";
import type * as payouts from "../payouts.js";
import type * as pinGuard from "../pinGuard.js";
import type * as rateLimit from "../rateLimit.js";
import type * as retention from "../retention.js";
import type * as signals from "../signals.js";
import type * as support from "../support.js";
import type * as telegramBot from "../telegramBot.js";
import type * as terminal from "../terminal.js";
import type * as terminalConfig from "../terminalConfig.js";
import type * as tokenDiscovery from "../tokenDiscovery.js";
import type * as trade from "../trade.js";
import type * as tradeAssets from "../tradeAssets.js";
import type * as tradeAutoDetection from "../tradeAutoDetection.js";
import type * as tradeCustody from "../tradeCustody.js";
import type * as tts from "../tts.js";
import type * as ttsCache from "../ttsCache.js";
import type * as users from "../users.js";
import type * as verify from "../verify.js";
import type * as whatsapp from "../whatsapp.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  "auth/operatorEmail": typeof auth_operatorEmail;
  "auth/otpMail": typeof auth_otpMail;
  "auth/password": typeof auth_password;
  bytecodeGuard: typeof bytecodeGuard;
  chainActivations: typeof chainActivations;
  copier: typeof copier;
  copierStore: typeof copierStore;
  crons: typeof crons;
  destinations: typeof destinations;
  discovery: typeof discovery;
  encryption: typeof encryption;
  executionBlocks: typeof executionBlocks;
  gate: typeof gate;
  gitSync: typeof gitSync;
  http: typeof http;
  kora: typeof kora;
  licenses: typeof licenses;
  mail: typeof mail;
  mailAction: typeof mailAction;
  marketData: typeof marketData;
  news: typeof news;
  notifications: typeof notifications;
  operatorDefaults: typeof operatorDefaults;
  operatorEmails: typeof operatorEmails;
  payouts: typeof payouts;
  pinGuard: typeof pinGuard;
  rateLimit: typeof rateLimit;
  retention: typeof retention;
  signals: typeof signals;
  support: typeof support;
  telegramBot: typeof telegramBot;
  terminal: typeof terminal;
  terminalConfig: typeof terminalConfig;
  tokenDiscovery: typeof tokenDiscovery;
  trade: typeof trade;
  tradeAssets: typeof tradeAssets;
  tradeAutoDetection: typeof tradeAutoDetection;
  tradeCustody: typeof tradeCustody;
  tts: typeof tts;
  ttsCache: typeof ttsCache;
  users: typeof users;
  verify: typeof verify;
  whatsapp: typeof whatsapp;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
