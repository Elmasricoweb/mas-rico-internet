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
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
  });
}

const db = admin.database();

exports.handler = async (event, context) => {
  // Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    // Verificar webhook de Stripe
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Error verificando webhook:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Webhook signature verification failed: ${err.message}` })
    };
  }

  // Procesar solo pagos exitosos
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const paymentIntent = stripeEvent.data.object;
    
    try {
      const nickname = paymentIntent.metadata.nickname;
      const amount = parseFloat(paymentIntent.metadata.originalAmount);
      const timestamp = Date.now();
      
      // Guardar en Firebase
      const donationRef = db.ref('donations').push();
      await donationRef.set({
        nickname: nickname,
        amount: amount,
        timestamp: timestamp,
        paymentIntentId: paymentIntent.id,
        email: paymentIntent.receipt_email || 'no-email'
      });

      // Actualizar el rey actual
      const currentKingRef = db.ref('currentKing');
      await currentKingRef.set({
        nickname: nickname,
        amount: amount,
        timestamp: timestamp,
        lastUpdated: Date.now()
      });

      console.log(`Nueva donación guardada: ${nickname} - €${amount}`);

      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          received: true,
          message: 'Donation saved successfully'
        })
      };

    } catch (error) {
      console.error('Error guardando en Firebase:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Error saving to database' })
      };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true })
  };
};