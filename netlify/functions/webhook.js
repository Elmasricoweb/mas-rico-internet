const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Inicializar Firebase Admin (solo una vez)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
  // Permitir CORS para OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sig = event.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      headers: {
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Webhook signature verification failed' })
    };
  }

  // Manejar el evento de pago completado
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    
    try {
      const nickname = paymentIntent.metadata.nickname;
      const amount = parseFloat(paymentIntent.metadata.originalAmount);
      
      console.log(`Processing payment: ${nickname} - $${amount}`);
      
      // Obtener el rey actual para el historial
      const currentKingDoc = await db.collection('current').doc('king').get();
      let previousKing = '@ReyInicial';
      
      if (currentKingDoc.exists) {
        previousKing = currentKingDoc.data().nickname;
      }

      // Actualizar el rey actual
      await db.collection('current').doc('king').set({
        nickname: nickname,
        amount: amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        paymentIntentId: paymentIntent.id
      });

      // Agregar al historial
      await db.collection('history').add({
        message: `${nickname} destronó a ${previousKing} con $${amount.toFixed(2)}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        paymentIntentId: paymentIntent.id
      });

      console.log(`Payment processed successfully: ${nickname} paid $${amount}`);
      
    } catch (error) {
      console.error('Error updating Firebase:', error);
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ error: 'Error updating database' })
      };
    }
  }

  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify({ received: true })
  };
};