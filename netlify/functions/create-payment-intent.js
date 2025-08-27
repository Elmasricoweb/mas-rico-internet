const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Inicializar Firebase Admin (solo una vez)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    }),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
  });
}

const db = admin.firestore();
const auth = admin.auth();

exports.handler = async (event, context) => {
  // Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Manejar preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  try {
    const { amount, idToken } = JSON.parse(event.body);

    // Validar que se proporcione el token de autenticación
    if (!idToken) {
      return {
        statusCode: 401,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({ error: 'Token de autenticación requerido' })
      };
    }

    // Verificar token de Firebase
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
      console.error('Error verificando token:', error);
      return {
        statusCode: 401,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({ error: 'Token inválido' })
      };
    }

    const userId = decodedToken.uid;

    // Validaciones básicas
    if (!amount || amount <= 0) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({ error: 'Cantidad inválida' })
      };
    }

    // Obtener datos del usuario actual
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      return {
        statusCode: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({ error: 'Usuario no encontrado' })
      };
    }

    const userData = userDoc.data();
    const currentUserInvested = userData.totalInvested || 0;

    // Obtener datos del rey actual
    const kingDoc = await db.collection('current').doc('king').get();
    let currentKingAmount = 10.00; // Valor por defecto
    
    if (kingDoc.exists) {
      currentKingAmount = kingDoc.data().amount || 10.00;
    }

    // Calcular el monto total necesario para ser rey (rey actual + $0.01 mínimo)
    const requiredTotalAmount = currentKingAmount + 0.01;
    
    // Calcular cuánto necesita pagar el usuario (diferencia entre lo requerido y lo ya invertido)
    const requiredPayment = requiredTotalAmount - currentUserInvested;

    // Validar que el monto enviado sea suficiente
    if (amount < requiredPayment) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({ 
          error: `Cantidad insuficiente. Necesitas pagar al menos $${requiredPayment.toFixed(2)}`,
          requiredPayment: requiredPayment,
          currentInvestment: currentUserInvested,
          requiredTotal: requiredTotalAmount
        })
      };
    }

    // Convertir a centavos (Stripe maneja centavos)
    const amountInCents = Math.round(amount * 100);
    
    // Calcular el nuevo total que tendrá el usuario después del pago
    const newTotalInvested = currentUserInvested + amount;

    // Crear Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      metadata: {
        userId: userId,
        username: userData.username,
        paymentAmount: amount.toString(),
        previousInvestment: currentUserInvested.toString(),
        newTotalInvestment: newTotalInvested.toString(),
        previousKingAmount: currentKingAmount.toString()
      },
      description: `Puja de ${userData.username} para ser el más rico de internet`
    });

    console.log(`Payment Intent creado para ${userData.username}: $${amount} (Total acumulado: $${newTotalInvested})`);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        userCurrentInvestment: currentUserInvested,
        paymentAmount: amount,
        newTotalInvestment: newTotalInvested,
        willBecomeKing: newTotalInvested > currentKingAmount
      })
    };

  } catch (error) {
    console.error('Error creating payment intent:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({ error: 'Error interno del servidor' })
    };
  }
};