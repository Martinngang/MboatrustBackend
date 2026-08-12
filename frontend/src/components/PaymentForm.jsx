import React, { useState, useEffect } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js'

function StripeCardForm({ clientSecret, publishableKey, onSuccess, onError }) {
  const stripe = useStripe()
  const elements = useElements()

  useEffect(() => {
    // no-op
  }, [clientSecret])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!stripe || !elements) return
    try {
      const res = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: elements.getElement(CardElement) },
      })
      if (res.error) return onError(res.error.message)
      onSuccess(res.paymentIntent)
    } catch (err) {
      onError(err.message)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card-form">
      <label>Card details</label>
      <div className="card-wrapper"><CardElement /></div>
      <button type="submit" disabled={!stripe}>Pay</button>
    </form>
  )
}

export default function PaymentForm() {
  const [backendUrl, setBackendUrl] = useState('http://localhost:5000')
  const [projectId, setProjectId] = useState('')
  const [amount, setAmount] = useState(50)
  const [currency, setCurrency] = useState('USD')
  const [paymentProvider, setPaymentProvider] = useState('stripe')
  const [devUserId, setDevUserId] = useState('')
  const [stripePk, setStripePk] = useState('')
  const [clientSecret, setClientSecret] = useState(null)
  const [paymentUrl, setPaymentUrl] = useState(null)
  const [status, setStatus] = useState(null)
  const [stripePromise, setStripePromise] = useState(null)

  useEffect(() => {
    if (stripePk) setStripePromise(loadStripe(stripePk))
  }, [stripePk])

  const submit = async () => {
    setStatus('initiating')
    if (!projectId) return setStatus('Enter project id')
    const idempotency = cryptoRandomId()
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency }
    if (devUserId) headers['x-dev-user-id'] = devUserId

    const body = { amount: Number(amount), paymentProvider, currency }
    try {
      const resp = await fetch(`${backendUrl}/api/v1/projects/${projectId}/fund`, { method: 'POST', headers, body: JSON.stringify(body) })
      const json = await resp.json()
      if (!json.success) throw new Error(json.error?.message || JSON.stringify(json.error) || 'Unknown error')
      const data = json.data || {}
      setStatus('created')
      if (data.clientSecret) {
        setClientSecret(data.clientSecret)
      } else if (data.paymentUrl) {
        setPaymentUrl(data.paymentUrl)
        // redirect to provider page
        window.location.href = data.paymentUrl
      } else {
        setStatus('completed')
      }
    } catch (err) {
      setStatus('error: ' + (err.message || String(err)))
    }
  }

  const onCardSuccess = (pi) => {
    setStatus('succeeded')
    // Optional: show result or refresh page
    alert('Payment succeeded: ' + pi.id)
    setClientSecret(null)
  }
  const onCardError = (msg) => setStatus('card error: ' + msg)

  return (
    <div className="payment-form">
      <label>Backend URL<input value={backendUrl} onChange={e=>setBackendUrl(e.target.value)} /></label>
      <label>Dev user id (x-dev-user-id)<input value={devUserId} onChange={e=>setDevUserId(e.target.value)} placeholder="optional"/></label>
      <label>Project ID<input value={projectId} onChange={e=>setProjectId(e.target.value)} placeholder="ObjectId required"/></label>

      <label>Amount<input type="number" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
      <label>Currency<select value={currency} onChange={e=>setCurrency(e.target.value)}><option>USD</option><option>EUR</option><option>GBP</option><option>XAF</option></select></label>

      <label>Provider<select value={paymentProvider} onChange={e=>setPaymentProvider(e.target.value)}>
        <option value="stripe">Stripe</option>
        <option value="flutterwave">Flutterwave</option>
        <option value="mtn_momo">MTN MoMo</option>
        <option value="orange_money">Orange Money</option>
      </select></label>

      {paymentProvider === 'stripe' && (
        <label>Stripe Publishable Key<input value={stripePk} onChange={e=>setStripePk(e.target.value)} placeholder="pk_test_..." /></label>
      )}

      <div className="actions">
        <button onClick={submit}>Create Payment</button>
      </div>

      <div className="status">Status: {status}</div>

      {clientSecret && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <StripeCardForm clientSecret={clientSecret} onSuccess={onCardSuccess} onError={onCardError} />
        </Elements>
      )}

      {paymentUrl && (
        <div>
          <p>Redirecting to payment provider...</p>
          <a href={paymentUrl} target="_blank" rel="noreferrer">Open payment page</a>
        </div>
      )}
    </div>
  )
}

function cryptoRandomId() {
  return 'id-' + Math.random().toString(36).slice(2, 11)
}
