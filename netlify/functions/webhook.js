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
      // Extraer datos del metadata (nuevo formato)
      const userId = paymentIntent.metadata.userId;
      const username = paymentIntent.metadata.username;
      const paymentAmount = parseFloat(paymentIntent.metadata.paymentAmount);
      const previousInvestment = parseFloat(paymentIntent.metadata.previousInvestment);
      const newTotalInvestment = parseFloat(paymentIntent.metadata.newTotalInvestment);
      const previousKingAmount = parseFloat(paymentIntent.metadata.previousKingAmount);
      
      console.log(`Processing payment: ${username} (${userId}) - Payment: $${paymentAmount}, New Total: $${newTotalInvestment}`);
      
      // Verificar que tenemos todos los datos necesarios
      if (!userId || !username || isNaN(paymentAmount) || isNaN(newTotalInvestment)) {
        console.error('Missing required metadata:', paymentIntent.metadata);
        throw new Error('Metadata incompleto en payment intent');
      }

      // Usar transacción para asegurar consistencia de datos
      await db.runTransaction(async (transaction) => {
        
        // 1. Actualizar el saldo del usuario
        const userRef = db.collection('users').doc(userId);
        const userDoc = await transaction.get(userRef);
        
        if (!userDoc.exists) {
          throw new Error(`Usuario ${userId} no encontrado`);
        }

        const userData = userDoc.data();
        const currentInvestment = userData.totalInvested || 0;

        // Actualizar el saldo del usuario
        transaction.update(userRef, {
          totalInvested: newTotalInvestment,
          lastPayment: {
            amount: paymentAmount,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            paymentIntentId: paymentIntent.id
          }
        });

        // 2. Verificar si debe convertirse en el nuevo rey
        const kingRef = db.collection('current').doc('king');
        const kingDoc = await transaction.get(kingRef);
        
        let currentKingData = {
          username: 'ReyInicial',
          amount: 10.00,
          userId: 'default'
        };
        
        if (kingDoc.exists) {
          currentKingData = kingDoc.data();
        }

        const shouldBecomeKing = newTotalInvestment > currentKingData.amount;
        
        if (shouldBecomeKing) {
          // 3. Actualizar el rey actual
          transaction.set(kingRef, {
            userId: userId,
            username: username,
            amount: newTotalInvestment,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            paymentIntentId: paymentIntent.id,
            crownedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          // 4. Actualizar estadísticas del nuevo rey
          const newKingStats = userData.stats || {};
          transaction.update(userRef, {
            stats: {
              timesAsKing: (newKingStats.timesAsKing || 0) + 1,
              totalTimeAsKing: newKingStats.totalTimeAsKing || 0,
              longestReign: newKingStats.longestReign || 0,
              lastCrowned: admin.firestore.FieldValue.serverTimestamp()
            }
          });

          // 5. Agregar al historial
          const historyRef = db.collection('history').doc();
          transaction.set(historyRef, {
            type: 'dethrone',
            newKing: {
              userId: userId,
              username: username,
              amount: newTotalInvestment
            },
            previousKing: {
              userId: currentKingData.userId,
              username: currentKingData.username,
              amount: currentKingData.amount
            },
            paymentDetails: {
              paymentAmount: paymentAmount,
              previousInvestment: previousInvestment,
              totalInvestment: newTotalInvestment
            },
            message: `${username} destronó a ${currentKingData.username} con $${newTotalInvestment.toFixed(2)} (pagó $${paymentAmount.toFixed(2)})`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            paymentIntentId: paymentIntent.id
          });

          console.log(`👑 NEW KING: ${username} with $${newTotalInvestment} (paid $${paymentAmount})`);
        } else {
          // Solo actualizar el historial de pago (no destronamiento)
          const paymentHistoryRef = db.collection('history').doc();
          transaction.set(paymentHistoryRef, {
            type: 'payment',
            user: {
              userId: userId,
              username: username
            },
            paymentDetails: {
              paymentAmount: paymentAmount,
              previousInvestment: previousInvestment,
              totalInvestment: newTotalInvestment
            },
            message: `${username} aumentó su inversión a $${newTotalInvestment.toFixed(2)} (pagó $${paymentAmount.toFixed(2)})`,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            paymentIntentId: paymentIntent.id
          });

          console.log(`💰 PAYMENT: ${username} invested $${paymentAmount}, total: $${newTotalInvestment} (King remains: ${currentKingData.username})`);
        }
      });

      console.log(`Payment processed successfully: ${username} paid $${paymentAmount}, total investment: $${newTotalInvestment}`);
      
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