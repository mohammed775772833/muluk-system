const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

const CREDIT_TYPES = ['PIECE_EARNING', 'BONUS'];
const DEBIT_TYPES = ['WITHDRAWAL', 'ADVANCE', 'DEDUCTION'];
const FLEXIBLE_TYPES = ['SETTLEMENT', 'ADJUSTMENT'];

const ALL_TYPES = [
    ...CREDIT_TYPES,
    ...DEBIT_TYPES,
    ...FLEXIBLE_TYPES
];

function getDirection(type, requestedDirection) {
    if (CREDIT_TYPES.includes(type)) return 'CREDIT';
    if (DEBIT_TYPES.includes(type)) return 'DEBIT';

    if (FLEXIBLE_TYPES.includes(type)) {
        return requestedDirection === 'DEBIT' ? 'DEBIT' : 'CREDIT';
    }

    return null;
}

/*
 * GET /api/employee-finance/employees
 * الموظفون مع أرصدتهم المالية
 */
router.get(
    '/employees',
    authenticateToken,
    requirePermission('EMPLOYEES_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    employee_id,
                    employee_no,
                    full_name,
                    job_title,
                    is_active,
                    current_balance,
                    total_credits,
                    total_debits
                FROM employee_financial_balances
                ORDER BY employee_id
            `);

            res.json({
                success: true,
                count: result.rows.length,
                employees: result.rows
            });
        } catch (error) {
            console.error('Get employee financial balances error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to get employee financial balances'
            });
        }
    }
);


/*
 * GET /api/employee-finance/:employeeId
 * كشف حساب موظف
 */
router.get(
    '/:employeeId',
    authenticateToken,
    requirePermission('EMPLOYEES_VIEW'),
    async (req, res) => {
        try {
            const { employeeId } = req.params;

            const employeeResult = await pool.query(`
                SELECT
                    employee_id,
                    employee_no,
                    full_name,
                    phone,
                    job_title,
                    is_active
                FROM employees
                WHERE employee_id = $1
            `, [employeeId]);

            if (employeeResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Employee not found'
                });
            }

            const balanceResult = await pool.query(`
                SELECT
                    employee_id,
                    current_balance,
                    total_credits,
                    total_debits
                FROM employee_financial_balances
                WHERE employee_id = $1
            `, [employeeId]);

            const transactionsResult = await pool.query(`
                SELECT
                    t.transaction_id,
                    t.transaction_no,
                    t.employee_id,
                    t.transaction_type,
                    t.amount,
                    t.direction,
                    t.work_order_id,
                    wo.work_order_no,
                    t.piecework_id,
                    t.description,
                    t.notes,
                    t.transaction_date,
                    t.created_by,
                    t.created_at
                FROM employee_financial_transactions t
                LEFT JOIN work_orders wo
                    ON wo.work_order_id = t.work_order_id
                WHERE t.employee_id = $1
                ORDER BY t.transaction_date DESC, t.transaction_id DESC
            `, [employeeId]);

            res.json({
                success: true,
                employee: employeeResult.rows[0],
                balance: balanceResult.rows[0] || {
                    employee_id: Number(employeeId),
                    current_balance: 0,
                    total_credits: 0,
                    total_debits: 0
                },
                transactions: transactionsResult.rows
            });

        } catch (error) {
            console.error('Get employee financial account error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to get employee financial account'
            });
        }
    }
);


/*
 * POST /api/employee-finance/transactions
 * تسجيل حركة مالية
 */
router.post(
    '/transactions',
    authenticateToken,
    requirePermission('EMPLOYEES_MANAGE'),
    async (req, res) => {
        const client = await pool.connect();

        try {
            const {
                employee_id,
                transaction_type,
                amount,
                direction,
                work_order_id,
                piecework_id,
                description,
                notes,
                transaction_date
            } = req.body;

            if (!employee_id) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id is required'
                });
            }

            if (!transaction_type || !ALL_TYPES.includes(transaction_type)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid transaction_type'
                });
            }

            const numericAmount = Number(amount);

            if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'amount must be greater than zero'
                });
            }

            const finalDirection = getDirection(
                transaction_type,
                direction
            );

            if (!finalDirection) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid transaction direction'
                });
            }

            const employeeResult = await client.query(`
                SELECT
                    employee_id,
                    employee_no,
                    full_name,
                    is_active
                FROM employees
                WHERE employee_id = $1
            `, [employee_id]);

            if (employeeResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Employee not found'
                });
            }

            if (!employeeResult.rows[0].is_active) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot create financial transaction for inactive employee'
                });
            }

            /*
             * السحب العادي لا يسمح بتجاوز الرصيد المستحق.
             * السلفة لها حساب مستقل ويمكن أن تجعل الرصيد مدينًا.
             */
            if (
                transaction_type === 'WITHDRAWAL' &&
                finalDirection === 'DEBIT'
            ) {
                const balanceResult = await client.query(`
                    SELECT current_balance
                    FROM employee_financial_balances
                    WHERE employee_id = $1
                `, [employee_id]);

                const currentBalance =
                    Number(balanceResult.rows[0]?.current_balance || 0);

                if (numericAmount > currentBalance) {
                    return res.status(400).json({
                        success: false,
                        message: 'Withdrawal amount exceeds employee current balance',
                        current_balance: currentBalance,
                        requested_amount: numericAmount
                    });
                }
            }

            /*
             * إذا تم تمرير أمر تشغيل، نتأكد أنه موجود.
             * لا يتم تعديل أمر التشغيل أو حالته.
             */
            if (work_order_id) {
                const workOrderResult = await client.query(`
                    SELECT work_order_id, work_order_no
                    FROM work_orders
                    WHERE work_order_id = $1
                `, [work_order_id]);

                if (workOrderResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Referenced work order not found'
                    });
                }
            }

            /*
             * إذا تم تمرير سجل قطعة، نتأكد أنه موجود.
             * لا نغير حالة سجل القطعة القديم.
             */
            if (piecework_id) {
                const pieceworkResult = await client.query(`
                    SELECT piecework_id, employee_id
                    FROM employee_piecework
                    WHERE piecework_id = $1
                `, [piecework_id]);

                if (pieceworkResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Referenced piecework record not found'
                    });
                }

                if (
                    Number(pieceworkResult.rows[0].employee_id) !==
                    Number(employee_id)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: 'Piecework record belongs to another employee'
                    });
                }
            }

            await client.query('BEGIN');

            const result = await client.query(`
                INSERT INTO employee_financial_transactions (
                    employee_id,
                    transaction_no,
                    transaction_type,
                    amount,
                    direction,
                    work_order_id,
                    piecework_id,
                    description,
                    notes,
                    transaction_date,
                    created_by
                )
                VALUES (
                    $1,
                    NULL,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    COALESCE($9::timestamptz, CURRENT_TIMESTAMP),
                    $10
                )
                RETURNING
                    transaction_id,
                    transaction_no,
                    employee_id,
                    transaction_type,
                    amount,
                    direction,
                    work_order_id,
                    piecework_id,
                    description,
                    notes,
                    transaction_date,
                    created_by,
                    created_at
            `, [
                employee_id,
                transaction_type,
                numericAmount,
                finalDirection,
                work_order_id || null,
                piecework_id || null,
                description || null,
                notes || null,
                transaction_date || null,
                req.user?.user_id || null
            ]);

            if (
            transaction_type === 'SETTLEMENT' &&
            finalDirection === 'DEBIT' &&
            piecework_id
        ) {
            await client.query(
                `UPDATE employee_piecework
                 SET status = 'PAID',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE piecework_id = $1
                   AND employee_id = $2
                   AND status = 'DUE'`,
                [piecework_id, employee_id]
            );
        }

        await client.query('COMMIT');

            res.status(201).json({
                success: true,
                message: 'Employee financial transaction created successfully',
                transaction: result.rows[0]
            });

        } catch (error) {
            await client.query('ROLLBACK');

            console.error(
                'Create employee financial transaction error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to create employee financial transaction'
            });

        } finally {
            client.release();
        }
    }
);

module.exports = router;
