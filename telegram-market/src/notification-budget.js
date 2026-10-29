import {SafeError} from './services.js';
export function remainingRequests(env){const b=env.NOTIFICATION_REQUEST_BUDGET;return b?b.limit-b.used:Infinity}
export function requireRequests(env,count=1){if(remainingRequests(env)<count)throw new SafeError('notification_budget_deferred',503)}
export async function budgetFetch(env,...args){requireRequests(env);if(env.NOTIFICATION_REQUEST_BUDGET)env.NOTIFICATION_REQUEST_BUDGET.used++;return fetch(...args)}
