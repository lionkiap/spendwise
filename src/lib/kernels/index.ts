/**
 * Barrel for the deterministic finance kernels.
 * Every number the app displays must come from one of these pure functions;
 * the LLM never computes figures on its own.
 */
export * from './tvom';
export * from './property';
export * from './cpf';
export * from './car';
