const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event, context) => {
  // Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { amount, nickname } = JSON.parse(event.body);

    // Validaciones básicas
    if (!amount || !nickname || amount <= 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Datos inválidos' })
      };
    }

    // Convertir a centavos (Stripe maneja centavos)
    const amountInCents = Math.round(amount * 100);

    // Crear Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      metadata: {
        nickname: nickname,
        originalAmount: amount.toString()
      },
      description: `Donación de ${nickname} para ser el más rico de internet`
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST'
      },
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      })
    };

  } catch (error) {
    console.error('Error creating payment intent:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno del servidor' })
    };
  }
};