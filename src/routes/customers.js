const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();
const { sendTemplateMessage } = require('../services/whatsapp/whatsapp');

// GET /api/customers
router.get(
    '/',
    authenticateToken,
    requirePermission('CUSTOMERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes,
                    created_at,
                    updated_at
                FROM customers
                ORDER BY customer_id DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                customers: result.rows
            });

        } catch (error) {
            console.error('Get customers error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch customers'
            });
        }
    }
);

// GET /api/customers/marketing/eligible
router.get(
    '/marketing/eligible',
    authenticateToken,
    requirePermission('CUSTOMERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    marketing_opt_in,
                    marketing_opt_in_at,
                    marketing_opt_in_source
                FROM customers
                WHERE marketing_opt_in = TRUE
                  AND phone IS NOT NULL
                  AND TRIM(phone) <> ''
                  AND phone <> 'INTERNAL-EMPLOYEE'
                ORDER BY customer_id DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                customers: result.rows
            });

        } catch (error) {
            console.error('Get marketing eligible customers error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch marketing eligible customers'
            });
        }
    }
);


// PATCH /api/customers/:id/marketing-consent
router.patch(
    '/:id/marketing-consent',
    authenticateToken,
    requirePermission('CUSTOMERS_MANAGE'),
    async (req, res) => {
        try {
            const customerId = Number(req.params.id);
            const { marketing_opt_in } = req.body;

            if (!Number.isInteger(customerId)) {
                return res.status(400).json({
                    success: false,
                    message: 'رقم العميل غير صحيح'
                });
            }

            if (typeof marketing_opt_in !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'قيمة الموافقة يجب أن تكون true أو false'
                });
            }

            const result = await pool.query(`
                UPDATE customers
                SET
                    marketing_opt_in = $1,
                    marketing_opt_in_at = CASE
                        WHEN $1 = TRUE THEN NOW()
                        ELSE NULL
                    END,
                    marketing_opt_in_source = CASE
                        WHEN $1 = TRUE THEN 'dashboard'
                        ELSE NULL
                    END
                WHERE customer_id = $2
                RETURNING
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    marketing_opt_in,
                    marketing_opt_in_at,
                    marketing_opt_in_source
            `, [marketing_opt_in, customerId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'العميل غير موجود'
                });
            }

            res.json({
                success: true,
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Marketing consent update error:', error);

            res.status(500).json({
                success: false,
                message: 'فشل تحديث الموافقة التسويقية'
            });
        }
    }
);


// POST /api/customers/marketing/test-offer
// اختبار مؤقت: يسمح فقط بالعميل رقم 6
router.post(
    '/marketing/test-offer',
    authenticateToken,
    requirePermission('CUSTOMERS_MANAGE'),
    async (req, res) => {
        try {
            const TEST_CUSTOMER_ID = 6;

            const result = await pool.query(`
                SELECT
                    customer_id,
                    full_name,
                    phone,
                    marketing_opt_in
                FROM customers
                WHERE customer_id = $1
                  AND marketing_opt_in = TRUE
                  AND phone IS NOT NULL
                  AND TRIM(phone) <> ''
                  AND phone <> 'INTERNAL-EMPLOYEE'
            `, [TEST_CUSTOMER_ID]);

            if (result.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'العميل التجريبي غير مؤهل للإرسال'
                });
            }

            const customer = result.rows[0];

            const response = await sendTemplateMessage(
                customer.phone,
                'muluk_royal_offer_booking',
                'ar'
            );

            res.json({
                success: true,
                message: 'تم إرسال العرض التجريبي',
                customer: {
                    customer_id: customer.customer_id,
                    full_name: customer.full_name,
                    phone: customer.phone
                },
                whatsapp: response
            });

        } catch (error) {
            console.error(
    'Marketing test offer error:',
    JSON.stringify(error.response?.data || { message: error.message }, null, 2)
);

            res.status(500).json({
                success: false,
                message: 'فشل إرسال العرض التجريبي',
                error: error.response?.data || error.message
            });
        }
    }
);

// GET /api/customers/:id
router.get(
    '/:id',
    authenticateToken,
    requirePermission('CUSTOMERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes,
                    created_at,
                    updated_at
                FROM customers
                WHERE customer_id = $1
            `, [req.params.id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer not found'
                });
            }

            res.json({
                success: true,
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Get customer error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch customer'
            });
        }
    }
);

// POST /api/customers
router.post(
    '/',
    authenticateToken,
    requirePermission('CUSTOMERS_MANAGE'),
    async (req, res) => {
        try {
            const {
                full_name,
                phone,
                alternate_phone,
                email,
                address,
                notes
            } = req.body;

            if (!full_name || !phone) {
                return res.status(400).json({
                    success: false,
                    message: 'Full name and phone are required'
                });
            }

            const result = await pool.query(`
                INSERT INTO customers (
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )
                RETURNING
                    customer_id,
                    customer_no,
                    full_name,
                    phone,
                    alternate_phone,
                    email,
                    address,
                    notes,
                    created_at,
                    updated_at
            `, [
                full_name,
                phone,
                alternate_phone || null,
                email || null,
                address || null,
                notes || null
            ]);

            res.status(201).json({
                success: true,
                message: 'Customer created successfully',
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Create customer error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to create customer'
            });
        }
    }
);

module.exports = router;
