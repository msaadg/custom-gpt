import { Hono } from 'hono';
import { PrismaClient } from '@prisma/client/edge'
import { withAccelerate } from '@prisma/extension-accelerate'
import { sign, verify } from 'hono/jwt'
import axios from 'axios';
import Stripe from 'stripe';
import { getSignedCookie, setSignedCookie } from 'hono/cookie'

const app = new Hono<{
  Bindings: {
    DATABASE_URL: string,
    JWT_SECRET: string,
    CLIENT_ID: string,
    CLIENT_SECRET: string,
    REDIRECT_URI: string,
    STRIPE_SECRET_KEY: string,
    STRIPE_SUCCESS_URL: string,
    STRIPE_CANCEL_URL: string,
    STRIPE_WEBHOOK_SECRET: string,
  }
  Variables: {
    userId: string,
  }
}>();

app.get('/oauth/callback', async (c) => {
  const prisma = new PrismaClient({
    datasourceUrl: c.env.DATABASE_URL,
  }).$extends(withAccelerate());

  const JWT_SECRET = c.env.JWT_SECRET;
  const CLIENT_ID = c.env.CLIENT_ID;
  const CLIENT_SECRET = c.env.CLIENT_SECRET;
  const REDIRECT_URI = c.env.REDIRECT_URI;

  const code = c.req.query('code');

  try {
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

  
    const tokenData = tokenResponse.data;
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

  
    const userInfo = userInfoResponse.data;
    const email = userInfo.email;

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email }
      });
    }
  
    const token = await sign({ userId: user.id }, JWT_SECRET); 
    // set token in cookie
    await setSignedCookie(c, 'token', token, JWT_SECRET, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 60 * 60 * 24, // 1 day
    });
    return c.redirect("https://chatgpt.com/g/g-dDhU9UEws-cryptobot");  // I want to redirect to the same chat
  } catch (error : any) {
    return c.json({ error: 'OAuth callback failed', details: error.message }, 500);
  }
});

app.post('/webhook', async (c) => {
  const sig = c.req.header('stripe-signature')!;
  const rawBody = await c.req.text();

  let event;

  try {
    event = await Stripe.webhooks.constructEventAsync(rawBody, sig, c.env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.log(`⚠️  Webhook signature verification failed.`, err.message);
    return c.json({ error: 'Webhook signature verification failed.' }, 400);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    // Update the user's status in the database
    const prisma = new PrismaClient({
      datasourceUrl: c.env.DATABASE_URL,
    }).$extends(withAccelerate());

    const userId = session.client_reference_id!;
    const endOfDay = new Date();
    endOfDay.setDate(endOfDay.getDate() + 1);

    await prisma.user.update({
      where: { id: userId },
      data: {
        paidUntil: endOfDay,
      },
    });

    console.log(`User ${userId} has paid for the day.`);
  }

  return c.json({ received: true }, 200);
});

app.use(async (c, next) => {
  const JWT_SECRET = c.env.JWT_SECRET;
  const CLIENT_ID = c.env.CLIENT_ID;
  const REDIRECT_URI = c.env.REDIRECT_URI;

  const googleAuthURL = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=openid%20email`;

  const token = await getSignedCookie(c, JWT_SECRET, 'token');
  if (!token) {
    return c.json({ error: 'User not authenticated', signInUrl: googleAuthURL }, 401);
  }

  try {
    const payload = await verify(token, JWT_SECRET) as { userId: string };
    c.set('userId', payload.userId as string);
    await next();
  } catch {
    return c.json({ error: 'Invalid token', signInUrl: googleAuthURL }, 401);
  }
});

app.get('/protected', async (c) => {
  const prisma = new PrismaClient({
    datasourceUrl: c.env.DATABASE_URL,
  }).$extends(withAccelerate());

  const userId = c.get('userId');
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) return c.json({ error: 'User not found' }, 404);

  const now = new Date();
  // const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // if (user.paidUntil && user.paidUntil > now) {
  //   user.hasPaidForDay = true;
  // } else {
  //   user.hasPaidForDay = false;
  // }

  if (user.requestCount < 4 || user.paidUntil && user.paidUntil > now) {
    await prisma.user.update({
      where: { id: userId },
      data: { requestCount: { increment: 1 }, lastLogin: now }
    });
    return c.json({ message: 'You are authenticated'});
  } else {
    // Use strip docs to create a checkout session
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'API Request',
            },
            unit_amount: 100,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: c.env.STRIPE_SUCCESS_URL,
      cancel_url: c.env.STRIPE_CANCEL_URL,
      client_reference_id: userId,
    });
    return c.json({ error: 'Payment required', stripeSessionUrl: session.url });
  }
});

export default app;