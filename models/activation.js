import email from 'infra/email.js';
import database from 'infra/database.js';
import user from 'models/user.js';
import authorization from 'models/authorization.js';
import { NotFoundError, ForbiddenError } from 'errors/index.js';

async function sendActivationEmailToUser(user) {
  const tokenObject = await createTokenInDatabase(user);
  await sendEmailToUser(user, tokenObject.id);

  async function createTokenInDatabase(user) {
    const query = {
      text: `INSERT INTO activate_account_tokens (user_id, expires_at)
             VALUES($1, now() + interval '15 minutes') RETURNING *;`,
      values: [user.id],
    };

    const results = await database.query(query);
    return results.rows[0];
  }

  async function sendEmailToUser(user, tokenId) {
    const activationPageEndpoint = getActivationPageEndpoint(tokenId);

    await email.send({
      from: {
        name: 'TabNews',
        address: 'contato@tabnews.com.br',
      },
      to: user.email,
      subject: 'Ative seu cadastro no TabNews',
      text: `${user.username}, clique no link abaixo para ativar seu cadastro no TabNews:

${activationPageEndpoint}

Caso você não tenha feito esta requisição, ignore esse email.

Atenciosamente,
Equipe TabNews
Rua Antônio da Veiga, 495, Blumenau, SC, 89012-500`,
    });
  }
}

function getWebServerHost() {
  let webserverHost = 'https://www.tabnews.com.br';

  if (['test', 'development'].includes(process.env.NODE_ENV) || process.env.CI) {
    webserverHost = `http://${process.env.WEBSERVER_HOST}:${process.env.WEBSERVER_PORT}`;
  }

  if (['preview'].includes(process.env.VERCEL_ENV)) {
    webserverHost = `https://${process.env.VERCEL_URL}`;
  }

  return webserverHost;
}

function getActivationApiEndpoint() {
  const webserverHost = getWebServerHost();
  return `${webserverHost}/api/v1/activation`;
}

function getActivationPageEndpoint(tokenId) {
  const webserverHost = getWebServerHost();
  return tokenId ? `${webserverHost}/cadastro/ativar/${tokenId}` : `${webserverHost}/cadastro/ativar`;
}

async function findOneTokenByUserId(userId) {
  const query = {
    text: 'SELECT * FROM activate_account_tokens WHERE user_id = $1 LIMIT 1;',
    values: [userId],
  };

  const results = await database.query(query);

  if (results.rowCount === 0) {
    throw new NotFoundError({
      message: `O token relacionado ao userId "${userId}" não foi encontrado no sistema.`,
      action: 'Verifique se o "id" do usuário está digitado corretamente.',
      stack: new Error().stack,
    });
  }

  return results.rows[0];
}

async function activateUserUsingTokenId(tokenId) {
  let tokenObject = await findOneTokenById(tokenId);
  if (!tokenObject.used) {
    tokenObject = await findOneValidTokenById(tokenId);
    await activateUserByUserId(tokenObject.user_id);
    return await markTokenAsUsed(tokenObject.id);
  }
  return tokenObject;
}

async function activateUserByUserId(userId) {
  const userToActivate = await user.findOneById(userId);

  if (!authorization.can(userToActivate, 'read:activation_token')) {
    throw new ForbiddenError({
      message: `O usuário "${userToActivate.username}" não pode ler o token de ativação.`,
      action:
        'Verifique se você está tentando ativar o usuário correto, se ele possui a feature "read:activation_token", ou se ele já está ativo.',
      stack: new Error().stack,
    });
  }

  // TODO: in the future, understand how to run
  // this inside a transaction, or at least
  // reduce how many queries are run.
  await user.removeFeatures(userToActivate.id, ['read:activation_token']);
  return await user.addFeatures(userToActivate.id, [
    'create:session',
    'read:session',
    'create:post',
    'create:comment',
    'update:user',
  ]);
}

async function findOneTokenById(tokenId) {
  const query = {
    text: `SELECT * FROM activate_account_tokens
        WHERE id = $1
        LIMIT 1;`,
    values: [tokenId],
  };

  const results = await database.query(query);

  if (results.rowCount === 0) {
    throw new NotFoundError({
      message: `O token "${tokenId}" não foi encontrado no sistema ou expirou.`,
      action: 'Faça um novo cadastro.',
      stack: new Error().stack,
    });
  }

  return results.rows[0];
}

async function findOneValidTokenById(tokenId) {
  const query = {
    text: `SELECT * FROM activate_account_tokens
        WHERE id = $1
        AND used = false
        AND expires_at >= now()
        LIMIT 1;`,
    values: [tokenId],
  };

  const results = await database.query(query);

  if (results.rowCount === 0) {
    throw new NotFoundError({
      message: `O token "${tokenId}" não foi encontrado no sistema ou expirou.`,
      action: 'Faça um novo cadastro.',
      stack: new Error().stack,
    });
  }

  return results.rows[0];
}

async function markTokenAsUsed(tokenId) {
  const query = {
    text: `UPDATE activate_account_tokens
            SET used = true
            WHERE id = $1
            RETURNING *;`,
    values: [tokenId],
  };

  const results = await database.query(query);

  return results.rows[0];
}

export default Object.freeze({
  sendActivationEmailToUser,
  findOneTokenByUserId,
  getActivationApiEndpoint,
  getActivationPageEndpoint,
  activateUserUsingTokenId,
  activateUserByUserId,
});
