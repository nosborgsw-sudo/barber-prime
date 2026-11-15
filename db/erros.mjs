// Erros de dados com código estável para o backend mapear em HTTP (docs/contrato-api.json).
// A mensagem nunca carrega SQL, valores ou dados pessoais.
export class DataError extends Error {
  constructor(code, message, { status, fields } = {}) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    this.status = status;
    if (fields) this.fields = fields;
  }
}

const STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  SLOT_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SCHEDULE_CONFLICT: 409,
  DUPLICATE: 409,
  BUSINESS_RULE: 422,
  RATE_LIMITED: 429,
  DB_UNAVAILABLE: 503,
};

export function dataError(code, message, fields) {
  return new DataError(code, message, { status: STATUS[code] ?? 500, fields });
}

// Converte erro do driver PostgreSQL (SQLSTATE) em DataError sem vazar detalhes.
export function translatePgError(err) {
  if (err instanceof DataError) return err;
  switch (err?.code) {
    case '23P01':
      if (err.constraint === 'working_hours_sem_sobreposicao') {
        return dataError('VALIDATION_ERROR', 'Turnos sobrepostos no mesmo dia.');
      }
      return dataError('SLOT_CONFLICT', 'Horário indisponível para este profissional.');
    case '23505':
      return dataError('DUPLICATE', 'Registro já existente.');
    case '23503':
      return dataError('NOT_FOUND', 'Referência inexistente.');
    case '23514':
      if (err.constraint === 'appointments_status_transition') {
        return dataError('BUSINESS_RULE', 'Transição de status não permitida.');
      }
      return dataError('VALIDATION_ERROR', 'Dados fora dos limites permitidos.');
    case '22P02':
    case '22007':
    case '22008':
    case '22023':
      return dataError('VALIDATION_ERROR', 'Formato de dado inválido.');
    case '57P01':
    case '57P03':
    case '08000':
    case '08003':
    case '08006':
    case 'ECONNREFUSED':
      return dataError('DB_UNAVAILABLE', 'Banco de dados indisponível.');
    default: {
      const wrapped = new DataError('INTERNAL', 'Erro interno de dados.', { status: 500 });
      wrapped.cause = err;
      return wrapped;
    }
  }
}
