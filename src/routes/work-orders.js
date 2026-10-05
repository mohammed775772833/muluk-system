const express = require('express');
const db = require('../../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uploadDir = path.join(
    process.cwd(),
    'uploads',
    'vehicle-photos'
);

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname);
        const filename =
            `wo-${req.params.id}-${Date.now()}${extension}`;

        cb(null, filename);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg',
            'image/png',
            'image/webp'
        ];

        if (!allowedTypes.includes(file.mimetype)) {
            return cb(
                new Error('Only JPG, PNG and WEBP images are allowed')
            );
        }

        cb(null, true);
    }
});
const pool = require('../../db');

const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

// Central work-order access control
async function authorizeWorkOrderAccess(req, res, next) {
    try {
        const isManager = (req.user.permissions || []).includes('WORK_ORDERS_MANAGE');

        // Managers/Admins with management permission can access all work orders
        if (isManager) {
            return next();
        }

        if (!req.user.employee_id) {
            return res.status(403).json({
                success: false,
                message: 'Employee account is not linked to an employee'
            });
        }

        const result = await pool.query(`
            SELECT 1
            FROM work_orders w
            WHERE w.work_order_id = $1
              AND (
                  w.assigned_to = $2
                  OR EXISTS (
                      SELECT 1
                      FROM work_order_stages ws
                      WHERE ws.work_order_id = w.work_order_id
                        AND ws.assigned_to = $2
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM work_order_tasks wt
                      WHERE wt.work_order_id = w.work_order_id
                        AND wt.assigned_to = $2
                  )
              )
            LIMIT 1
        `, [req.params.id, req.user.employee_id]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Work order not found'
            });
        }

        next();
    } catch (error) {
        console.error('Work order access authorization error:', error);

        return res.status(500).json({
            success: false,
            message: 'Failed to authorize work order access'
        });
    }
}


/* ============================================================
   CONTINUAL IMPROVEMENTS - ISO 9001
   ============================================================ */

// GET all continual improvements
router.get('/improvements', authenticateToken, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        ci.improvement_id,
        ci.improvement_no,
        ci.branch_id,
        b.branch_name,
        ci.title,
        ci.problem_or_opportunity,
        ci.proposed_improvement,
        ci.expected_benefit,
        ci.responsible_employee_id,
        e.full_name AS responsible_employee_name,
        ci.due_date,
        ci.implemented_at,
        ci.effectiveness_result,
        ci.status,
        ci.created_by,
        ci.created_at,
        ci.updated_at
      FROM continual_improvements ci
      LEFT JOIN branches b
        ON b.branch_id = ci.branch_id
      LEFT JOIN employees e
        ON e.employee_id = ci.responsible_employee_id
      ORDER BY ci.improvement_id DESC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      improvements: result.rows
    });

  } catch (error) {
    console.error('GET continual improvements error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch continual improvements',
      error: error.message
    });
  }
});


// GET one continual improvement
router.get('/improvements/:improvementId', authenticateToken, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
  try {
    const { improvementId } = req.params;

    const result = await db.query(`
      SELECT
        ci.improvement_id,
        ci.improvement_no,
        ci.branch_id,
        b.branch_name,
        ci.title,
        ci.problem_or_opportunity,
        ci.proposed_improvement,
        ci.expected_benefit,
        ci.responsible_employee_id,
        e.full_name AS responsible_employee_name,
        ci.due_date,
        ci.implemented_at,
        ci.effectiveness_result,
        ci.status,
        ci.created_by,
        ci.created_at,
        ci.updated_at
      FROM continual_improvements ci
      LEFT JOIN branches b
        ON b.branch_id = ci.branch_id
      LEFT JOIN employees e
        ON e.employee_id = ci.responsible_employee_id
      WHERE ci.improvement_id = $1
      LIMIT 1
    `, [improvementId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Continual improvement not found'
      });
    }

    res.json({
      success: true,
      improvement: result.rows[0]
    });

  } catch (error) {
    console.error('GET continual improvement error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch continual improvement',
      error: error.message
    });
  }
});


// CREATE continual improvement
router.post('/improvements', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const {
      branch_id,
      title,
      problem_or_opportunity,
      proposed_improvement,
      expected_benefit,
      responsible_employee_id,
      due_date,
      status
    } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({
        success: false,
        message: 'title is required'
      });
    }

    const allowedStatuses = [
      'PROPOSED',
      'APPROVED',
      'IN_PROGRESS',
      'IMPLEMENTED',
      'EFFECTIVE',
      'CANCELLED'
    ];

    const improvementStatus = status || 'PROPOSED';

    if (!allowedStatuses.includes(improvementStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid improvement status',
        allowed_statuses: allowedStatuses
      });
    }

    // Validate branch if supplied
    if (branch_id !== undefined && branch_id !== null && branch_id !== '') {
      const branchCheck = await db.query(`
        SELECT branch_id
        FROM branches
        WHERE branch_id = $1
        LIMIT 1
      `, [branch_id]);

      if (branchCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid branch_id'
        });
      }
    }

    // Validate responsible employee if supplied
    if (
      responsible_employee_id !== undefined &&
      responsible_employee_id !== null &&
      responsible_employee_id !== ''
    ) {
      const employeeCheck = await db.query(`
        SELECT employee_id
        FROM employees
        WHERE employee_id = $1
          AND is_active = true
        LIMIT 1
      `, [responsible_employee_id]);

      if (employeeCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive responsible_employee_id'
        });
      }
    }

    const result = await db.query(`
      INSERT INTO continual_improvements (
        branch_id,
        title,
        problem_or_opportunity,
        proposed_improvement,
        expected_benefit,
        responsible_employee_id,
        due_date,
        status,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      branch_id || null,
      String(title).trim(),
      problem_or_opportunity ?? null,
      proposed_improvement ?? null,
      expected_benefit ?? null,
      responsible_employee_id || null,
      due_date || null,
      improvementStatus,
      req.user.user_id
    ]);

    res.status(201).json({
      success: true,
      message: 'Continual improvement created successfully',
      improvement: result.rows[0]
    });

  } catch (error) {
    console.error('POST continual improvement error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to create continual improvement',
      error: error.message
    });
  }
});


// UPDATE continual improvement
router.patch('/improvements/:improvementId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { improvementId } = req.params;

    const {
      branch_id,
      title,
      problem_or_opportunity,
      proposed_improvement,
      expected_benefit,
      responsible_employee_id,
      due_date,
      implemented_at,
      effectiveness_result,
      status
    } = req.body;

    const allowedStatuses = [
      'PROPOSED',
      'APPROVED',
      'IN_PROGRESS',
      'IMPLEMENTED',
      'EFFECTIVE',
      'CANCELLED'
    ];

    if (status !== undefined && status !== null &&
        !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid improvement status',
        allowed_statuses: allowedStatuses
      });
    }

    const existing = await db.query(`
      SELECT improvement_id
      FROM continual_improvements
      WHERE improvement_id = $1
      LIMIT 1
    `, [improvementId]);

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Continual improvement not found'
      });
    }

    if (branch_id !== undefined && branch_id !== null && branch_id !== '') {
      const branchCheck = await db.query(`
        SELECT branch_id
        FROM branches
        WHERE branch_id = $1
        LIMIT 1
      `, [branch_id]);

      if (branchCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid branch_id'
        });
      }
    }

    if (
      responsible_employee_id !== undefined &&
      responsible_employee_id !== null &&
      responsible_employee_id !== ''
    ) {
      const employeeCheck = await db.query(`
        SELECT employee_id
        FROM employees
        WHERE employee_id = $1
          AND is_active = true
        LIMIT 1
      `, [responsible_employee_id]);

      if (employeeCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive responsible_employee_id'
        });
      }
    }

    const result = await db.query(`
      UPDATE continual_improvements
      SET
        branch_id = COALESCE($1, branch_id),
        title = COALESCE($2, title),
        problem_or_opportunity = COALESCE($3, problem_or_opportunity),
        proposed_improvement = COALESCE($4, proposed_improvement),
        expected_benefit = COALESCE($5, expected_benefit),
        responsible_employee_id = COALESCE($6, responsible_employee_id),
        due_date = COALESCE($7, due_date),
        implemented_at = COALESCE($8, implemented_at),
        effectiveness_result = COALESCE($9, effectiveness_result),
        status = COALESCE($10, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE improvement_id = $11
      RETURNING *
    `, [
      branch_id ?? null,
      title ? String(title).trim() : null,
      problem_or_opportunity ?? null,
      proposed_improvement ?? null,
      expected_benefit ?? null,
      responsible_employee_id ?? null,
      due_date ?? null,
      implemented_at ?? null,
      effectiveness_result ?? null,
      status ?? null,
      improvementId
    ]);

    res.json({
      success: true,
      message: 'Continual improvement updated successfully',
      improvement: result.rows[0]
    });

  } catch (error) {
    console.error('PATCH continual improvement error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to update continual improvement',
      error: error.message
    });
  }
});


router.delete('/:id', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const workOrderId = req.params.id;

        await client.query('BEGIN');

        const orderResult = await client.query(`
            SELECT
                work_order_id,
                work_order_no,
                status
            FROM work_orders
            WHERE work_order_id = $1
            FOR UPDATE
        `, [workOrderId]);

        if (orderResult.rows.length === 0) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                success: false,
                message: 'أمر التشغيل غير موجود'
            });
        }

        const order = orderResult.rows[0];

        // الحذف مسموح فقط للأوامر الجديدة التي لم يتم الاتفاق عليها
        if (order.status !== 'NEW') {
            await client.query('ROLLBACK');

            return res.status(400).json({
                success: false,
                message: 'لا يمكن حذف أمر التشغيل بعد اعتماده أو بدء العمل عليه'
            });
        }

        // منع حذف أي أمر عليه سند قبض
        const receiptResult = await client.query(`
            SELECT COUNT(*)::int AS count
            FROM payment_receipts
            WHERE work_order_id = $1
        `, [workOrderId]);

        if (receiptResult.rows[0].count > 0) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                success: false,
                message: 'لا يمكن حذف أمر التشغيل لأنه مرتبط بسند قبض'
            });
        }

        // التحقق من وجود تسليم أو ضمان قبل الحذف
        const deliveryResult = await client.query(`
            SELECT COUNT(*)::int AS count
            FROM deliveries
            WHERE work_order_id = $1
        `, [workOrderId]);

        if (deliveryResult.rows[0].count > 0) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                success: false,
                message: 'لا يمكن حذف أمر التشغيل لأنه مرتبط ببيانات تسليم'
            });
        }

        const warrantyResult = await client.query(`
            SELECT COUNT(*)::int AS count
            FROM warranties
            WHERE work_order_id = $1
        `, [workOrderId]);

        if (warrantyResult.rows[0].count > 0) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                success: false,
                message: 'لا يمكن حذف أمر التشغيل لأنه مرتبط بضمان'
            });
        }

        await client.query(`
            DELETE FROM work_orders
            WHERE work_order_id = $1
        `, [workOrderId]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'تم حذف أمر التشغيل بنجاح',
            work_order_id: order.work_order_id,
            work_order_no: order.work_order_no
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('DELETE work order error:', error);

        res.status(500).json({
            success: false,
            message: 'تعذر حذف أمر التشغيل',
            error: error.message
        });

    } finally {
        client.release();
    }
});


// PATCH /api/work-orders/:id
router.patch('/:id', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const {
            customer_id,
            vehicle_id,
            priority,
            promised_at,
            customer_notes,
            internal_notes,
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            deposit_amount
        } = req.body;

        await client.query('BEGIN');

        const existing = await client.query(`
            SELECT work_order_id, status
            FROM work_orders
            WHERE work_order_id = $1
            FOR UPDATE
        `, [workOrderId]);

        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'أمر التشغيل غير موجود'
            });
        }

        if (existing.rows[0].status !== 'NEW') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'يمكن تعديل أمر التشغيل فقط وهو في حالة NEW'
            });
        }

        if (customer_id !== undefined) {
            const customer = await client.query(
                'SELECT customer_id FROM customers WHERE customer_id = $1',
                [customer_id]
            );

            if (customer.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'العميل غير موجود'
                });
            }
        }

        if (vehicle_id !== undefined && vehicle_id !== null) {
            const vehicle = await client.query(
                'SELECT vehicle_id FROM vehicles WHERE vehicle_id = $1',
                [vehicle_id]
            );

            if (vehicle.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'السيارة غير موجودة'
                });
            }
        }

        const result = await client.query(`
            UPDATE work_orders
            SET
                customer_id = COALESCE($1, customer_id),
                vehicle_id = $2,
                priority = COALESCE($3, priority),
                promised_at = $4,
                customer_notes = $5,
                internal_notes = $6,
                subtotal = COALESCE($7, subtotal),
                discount_amount = COALESCE($8, discount_amount),
                tax_amount = COALESCE($9, tax_amount),
                total_amount = COALESCE($10, total_amount),
                deposit_amount = COALESCE($11, deposit_amount),
                balance_amount = COALESCE($10, total_amount) - COALESCE($11, deposit_amount),
                updated_at = NOW()
            WHERE work_order_id = $12
            RETURNING *
        `, [
            customer_id,
            vehicle_id === undefined ? null : vehicle_id,
            priority,
            promised_at || null,
            customer_notes ?? null,
            internal_notes ?? null,
            subtotal,
            discount_amount,
            tax_amount,
            total_amount,
            deposit_amount,
            workOrderId
        ]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'تم تعديل أمر التشغيل بنجاح',
            work_order: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('PATCH work order error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to update work order',
            error: error.message
        });
    } finally {
        client.release();
    }
});

router.get('/:id/services', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const result = await pool.query(`
            SELECT
                wos.work_order_service_id,
                wos.work_order_id,
                wos.service_id,
                s.service_name,
                wos.quantity,
                wos.unit_price,
                wos.discount,
                wos.notes,
                (wos.quantity * wos.unit_price - wos.discount) AS line_total
            FROM work_order_services wos
            JOIN services s
                ON s.service_id = wos.service_id
            WHERE wos.work_order_id = $1
            ORDER BY wos.work_order_service_id ASC
        `, [workOrderId]);

        res.json({
            success: true,
            count: result.rows.length,
            services: result.rows
        });

    } catch (error) {
        console.error('GET work order services error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch work order services'
        });
    }
});

router.patch('/:id/services/:workOrderServiceId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const workOrderId = Number(req.params.id);
        const workOrderServiceId = Number(req.params.workOrderServiceId);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0 ||
            !Number.isInteger(workOrderServiceId) || workOrderServiceId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid service or work order ID'
            });
        }

        const {
            quantity,
            unit_price,
            discount,
            notes
        } = req.body;

        await client.query('BEGIN');

        const order = await client.query(`
            SELECT work_order_id, status
            FROM work_orders
            WHERE work_order_id = $1
            FOR UPDATE
        `, [workOrderId]);

        if (order.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'أمر التشغيل غير موجود'
            });
        }

        if (order.rows[0].status !== 'NEW') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'يمكن تعديل الخدمات فقط وأمر التشغيل في حالة NEW'
            });
        }

        const existing = await client.query(`
            SELECT work_order_service_id
            FROM work_order_services
            WHERE work_order_service_id = $1
              AND work_order_id = $2
        `, [workOrderServiceId, workOrderId]);

        if (existing.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'الخدمة غير موجودة في أمر التشغيل'
            });
        }

        const finalQuantity = Number(quantity);
        const finalUnitPrice = Number(unit_price);
        const finalDiscount = Number(discount || 0);

        if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'العدد يجب أن يكون أكبر من صفر'
            });
        }

        if (!Number.isFinite(finalUnitPrice) || finalUnitPrice < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'سعر الوحدة غير صحيح'
            });
        }

        if (!Number.isFinite(finalDiscount) || finalDiscount < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'الخصم غير صحيح'
            });
        }

        const result = await client.query(`
            UPDATE work_order_services
            SET
                quantity = $1,
                unit_price = $2,
                discount = $3,
                notes = $4
            WHERE work_order_service_id = $5
              AND work_order_id = $6
            RETURNING *
        `, [
            finalQuantity,
            finalUnitPrice,
            finalDiscount,
            notes ?? null,
            workOrderServiceId,
            workOrderId
        ]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'تم تعديل الخدمة بنجاح',
            service: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('PATCH work order service error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to update work order service',
            error: error.message
        });
    } finally {
        client.release();
    }
});

router.delete('/:id/services/:workOrderServiceId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const workOrderId = Number(req.params.id);
        const workOrderServiceId = Number(req.params.workOrderServiceId);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0 ||
            !Number.isInteger(workOrderServiceId) || workOrderServiceId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid service or work order ID'
            });
        }

        await client.query('BEGIN');

        const order = await client.query(`
            SELECT work_order_id, status
            FROM work_orders
            WHERE work_order_id = $1
            FOR UPDATE
        `, [workOrderId]);

        if (order.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'أمر التشغيل غير موجود'
            });
        }

        if (order.rows[0].status !== 'NEW') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'يمكن حذف الخدمات فقط وأمر التشغيل في حالة NEW'
            });
        }

        const result = await client.query(`
            DELETE FROM work_order_services
            WHERE work_order_service_id = $1
              AND work_order_id = $2
            RETURNING work_order_service_id
        `, [workOrderServiceId, workOrderId]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'الخدمة غير موجودة في أمر التشغيل'
            });
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'تم حذف الخدمة بنجاح',
            work_order_service_id: result.rows[0].work_order_service_id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('DELETE work order service error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to delete work order service',
            error: error.message
        });
    } finally {
        client.release();
    }
});

router.post('/:id/services', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = req.params.id;
        const { service_id, quantity = 1, unit_price, discount = 0, notes } = req.body;

        if (!service_id) {
            return res.status(400).json({ success: false, message: 'service_id is required' });
        }

        const workOrder = await pool.query(
            'SELECT work_order_id FROM work_orders WHERE work_order_id = $1',
            [workOrderId]
        );

        if (workOrder.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Work order not found' });
        }

        const service = await pool.query(
            `SELECT service_id, service_code, service_name, standard_price, is_active
             FROM services
             WHERE service_id = $1`,
            [service_id]
        );

        if (service.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Service not found' });
        }

        if (!service.rows[0].is_active) {
            return res.status(400).json({ success: false, message: 'Service is not active' });
        }

        const finalQuantity = Number(quantity);
        const finalUnitPrice = unit_price !== undefined && unit_price !== null
            ? Number(unit_price)
            : Number(service.rows[0].standard_price);
        const finalDiscount = Number(discount);

        if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
            return res.status(400).json({ success: false, message: 'quantity must be greater than 0' });
        }

        if (!Number.isFinite(finalUnitPrice) || finalUnitPrice < 0) {
            return res.status(400).json({ success: false, message: 'unit_price must be 0 or greater' });
        }

        if (!Number.isFinite(finalDiscount) || finalDiscount < 0) {
            return res.status(400).json({ success: false, message: 'discount must be 0 or greater' });
        }

        const result = await pool.query(
            `INSERT INTO work_order_services
                (work_order_id, service_id, quantity, unit_price, discount, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING work_order_service_id, work_order_id, service_id,
                       quantity, unit_price, discount, notes`,
            [workOrderId, service_id, finalQuantity, finalUnitPrice, finalDiscount, notes || null]
        );

        res.status(201).json({
            success: true,
            message: 'Service added to work order successfully',
            work_order_service: {
                ...result.rows[0],
                service_code: service.rows[0].service_code,
                service_name: service.rows[0].service_name
            }
        });
    } catch (error) {
        console.error('Add work order service error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add service to work order'
        });
    }
});



async function createDefaultWorkOrderStages(workOrderId) {
    const stages = [
        'استقبال العميل',
        'معاينة السيارة',
        'تحديد طلب العميل',
        'اعتماد التصميم والخامات والسعر',
        'التنفيذ',
        'الفحص أثناء العمل',
        'الفحص النهائي',
        'التصحيح عند الحاجة',
        'جاهز للتسليم',
        'التسليم',
        'إغلاق أمر العمل'
    ];

    for (let i = 0; i < stages.length; i++) {
        await pool.query(
            `INSERT INTO work_order_stages
                (work_order_id, stage_name, stage_order, status)
             VALUES ($1, $2, $3, 'PENDING')
             ON CONFLICT (work_order_id, stage_order) DO NOTHING`,
            [workOrderId, stages[i], i + 1]
        );
    }
}

// ==================== WORK ORDER STAGES ====================

router.get('/:id/stages', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const result = await pool.query(
            `SELECT
                stage_id,
                work_order_id,
                stage_name,
                stage_order,
                status,
                assigned_to,
                started_at,
                completed_at,
                notes
             FROM work_order_stages
             WHERE work_order_id = $1
             ORDER BY stage_order ASC`,
            [workOrderId]
        );

        res.json({
            success: true,
            stages: result.rows
        });
    } catch (error) {
        console.error('Get work order stages error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get work order stages'
        });
    }
});
// ==================== UPDATE WORK ORDER STAGE ====================

router.patch('/:id/stages/:stageId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);
        const stageId = Number(req.params.stageId);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0 ||
            !Number.isInteger(stageId) || stageId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order or stage ID'
            });
        }

        const { status, assigned_to, notes } = req.body;

        const allowedStatuses = [
            'PENDING',
            'IN_PROGRESS',
            'COMPLETED',
            'BLOCKED',
            'CANCELLED'
        ];

        if (status !== undefined && !allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid stage status'
            });
        }

        if (assigned_to !== undefined && assigned_to !== null) {
            const employeeId = Number(assigned_to);

            if (!Number.isInteger(employeeId) || employeeId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid employee ID'
                });
            }
        }

        const existing = await pool.query(
            `SELECT stage_id, stage_name, status, assigned_to, notes
             FROM work_order_stages
             WHERE stage_id = $1
               AND work_order_id = $2`,
            [stageId, workOrderId]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Stage not found'
            });
        }

        const current = existing.rows[0];
        const newStatus = status !== undefined ? status : current.status;
        const newAssignedTo = assigned_to !== undefined ? assigned_to : current.assigned_to;
        const newNotes = notes !== undefined ? notes : current.notes;

        let startedAt = null;
        let completedAt = null;

        if (newStatus === 'IN_PROGRESS') {
            startedAt = current.status === 'IN_PROGRESS'
                ? undefined
                : new Date();
        }

        if (newStatus === 'COMPLETED') {
            startedAt = current.status === 'IN_PROGRESS'
                ? undefined
                : new Date();
            completedAt = new Date();
        }

        const result = await pool.query(
            `UPDATE work_order_stages
             SET
                 status = $1::task_status,
                 assigned_to = $2,
                 notes = $3,
                 started_at = CASE
                     WHEN $1::task_status IN ('IN_PROGRESS'::task_status, 'COMPLETED'::task_status)
                         AND started_at IS NULL
                     THEN NOW()
                     ELSE started_at
                 END,
                 completed_at = CASE
                     WHEN $1::task_status = 'COMPLETED'::task_status
                     THEN NOW()
                     WHEN $1::task_status <> 'COMPLETED'::task_status
                     THEN NULL
                     ELSE completed_at
                 END
             WHERE stage_id = $4
               AND work_order_id = $5
             RETURNING
                 stage_id,
                 work_order_id,
                 stage_name,
                 stage_order,
                 status,
                 assigned_to,
                 started_at,
                 completed_at,
                 notes`,
            [
                newStatus,
                newAssignedTo,
                newNotes,
                stageId,
                workOrderId
            ]
        );

        // ==================== READY FOR DELIVERY ====================
        // عند إكمال مرحلة "جاهز للتسليم" يتم تحديث حالة أمر العمل تلقائيًا.
        if (
            result.rows.length > 0 &&
            result.rows[0].stage_name === 'جاهز للتسليم' &&
            result.rows[0].status === 'COMPLETED'
        ) {
            await pool.query(
                `UPDATE work_orders
                 SET status = 'READY_FOR_DELIVERY',
                     completed_at = COALESCE(completed_at, NOW()),
                     updated_at = NOW()
                 WHERE work_order_id = $1`,
                [workOrderId]
            );
        }
        // ==================== END READY FOR DELIVERY ====================

        res.json({
            success: true,
            message: 'Work order stage updated successfully',
            stage: result.rows[0],
            work_order_status:
                result.rows[0].stage_name === 'جاهز للتسليم' &&
                result.rows[0].status === 'COMPLETED'
                    ? 'READY_FOR_DELIVERY'
                    : undefined
        });

    } catch (error) {
        console.error('Update work order stage error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to update work order stage'
        });
    }
});
// ==================== WORK ORDER TASKS ====================

router.get('/:id/tasks', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const result = await pool.query(
            `SELECT
                t.task_id,
                t.work_order_id,
                t.stage_id,
                s.stage_name,
                s.stage_order,
                t.task_name,
                t.description,
                t.assigned_to,
                e.full_name AS assigned_to_name,
                t.status,
                t.priority,
                t.estimated_minutes,
                t.actual_minutes,
                t.started_at,
                t.completed_at,
                t.notes,
                t.created_at,
                t.updated_at
             FROM work_order_tasks t
             LEFT JOIN work_order_stages s
                ON s.stage_id = t.stage_id
             LEFT JOIN employees e
                ON e.employee_id = t.assigned_to
             WHERE t.work_order_id = $1
             ORDER BY
                COALESCE(s.stage_order, 999999),
                t.task_id ASC`,
            [workOrderId]
        );

        res.json({
            success: true,
            count: result.rows.length,
            tasks: result.rows
        });

    } catch (error) {
        console.error('Get work order tasks error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to get work order tasks'
        });
    }
});


router.post('/:id/tasks', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const {
            stage_id,
            task_name,
            description,
            assigned_to,
            status,
            priority,
            estimated_minutes,
            notes
        } = req.body;

        if (!task_name || !String(task_name).trim()) {
            return res.status(400).json({
                success: false,
                message: 'Task name is required'
            });
        }

        let stageId = null;

        if (stage_id !== undefined && stage_id !== null && stage_id !== '') {
            stageId = Number(stage_id);

            if (!Number.isInteger(stageId) || stageId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid stage ID'
                });
            }

            const stageCheck = await pool.query(
                `SELECT stage_id
                 FROM work_order_stages
                 WHERE stage_id = $1
                   AND work_order_id = $2`,
                [stageId, workOrderId]
            );

            if (stageCheck.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Stage does not belong to this work order'
                });
            }
        }

        let assignedTo = null;

        if (assigned_to !== undefined && assigned_to !== null && assigned_to !== '') {
            assignedTo = Number(assigned_to);

            if (!Number.isInteger(assignedTo) || assignedTo <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid employee ID'
                });
            }

            const employeeCheck = await pool.query(
                `SELECT employee_id
                 FROM employees
                 WHERE employee_id = $1
                   AND is_active = TRUE`,
                [assignedTo]
            );

            if (employeeCheck.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Employee not found or inactive'
                });
            }
        }

        const allowedStatuses = [
            'PENDING',
            'IN_PROGRESS',
            'COMPLETED',
            'BLOCKED',
            'CANCELLED'
        ];

        const allowedPriorities = [
            'LOW',
            'NORMAL',
            'HIGH',
            'URGENT'
        ];

        const taskStatus = status || 'PENDING';
        const taskPriority = priority || 'NORMAL';

        if (!allowedStatuses.includes(taskStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid task status'
            });
        }

        if (!allowedPriorities.includes(taskPriority)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid task priority'
            });
        }

        let estimatedMinutes = null;

        if (
            estimated_minutes !== undefined &&
            estimated_minutes !== null &&
            estimated_minutes !== ''
        ) {
            estimatedMinutes = Number(estimated_minutes);

            if (
                !Number.isInteger(estimatedMinutes) ||
                estimatedMinutes < 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Estimated minutes must be a non-negative integer'
                });
            }
        }

        const result = await pool.query(
            `INSERT INTO work_order_tasks
                (
                    work_order_id,
                    stage_id,
                    task_name,
                    description,
                    assigned_to,
                    status,
                    priority,
                    estimated_minutes,
                    notes,
                    started_at,
                    completed_at
                )
             VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    CASE
                        WHEN $6::task_status = 'IN_PROGRESS'::task_status
                        THEN NOW()
                        ELSE NULL
                    END,
                    CASE
                        WHEN $6::task_status = 'COMPLETED'::task_status
                        THEN NOW()
                        ELSE NULL
                    END
                )
             RETURNING
                task_id,
                work_order_id,
                stage_id,
                task_name,
                description,
                assigned_to,
                status,
                priority,
                estimated_minutes,
                actual_minutes,
                started_at,
                completed_at,
                notes,
                created_at,
                updated_at`,
            [
                workOrderId,
                stageId,
                String(task_name).trim(),
                description || null,
                assignedTo,
                taskStatus,
                taskPriority,
                estimatedMinutes,
                notes || null
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Work order task created successfully',
            task: result.rows[0]
        });

    } catch (error) {
        console.error('Create work order task error:', error);

        res.status(500).json({
            success: false,
            message: 'Failed to create work order task'
        });
    }
});

// ==================== DESIGN APPROVALS ====================

router.get('/:id/design-approvals', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const result = await pool.query(
            `SELECT
                approval_id,
                work_order_id,
                version_no,
                design_description,
                color_specification,
                material_specification,
                modification_description,
                design_file_url,
                status,
                approved_by_customer,
                approved_total_amount,
                approved_at,
                rejection_reason,
                created_by,
                created_at
             FROM design_approvals
             WHERE work_order_id = $1
             ORDER BY version_no DESC`,
            [workOrderId]
        );

        res.json({
            success: true,
            count: result.rows.length,
            approvals: result.rows
        });

    } catch (error) {
        console.error('Get design approvals error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get design approvals'
        });
    }
});


router.post('/:id/design-approvals', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const workOrder = await pool.query(
            `SELECT work_order_id, total_amount FROM work_orders
             WHERE work_order_id = $1`,
            [workOrderId]
        );

        if (workOrder.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Work order not found'
            });
        }

        const {
            design_description,
            color_specification,
            material_specification,
            modification_description,
            design_file_url
        } = req.body;

        const latest = await pool.query(
            `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
             FROM design_approvals
             WHERE work_order_id = $1`,
            [workOrderId]
        );

        const versionNo = Number(latest.rows[0].next_version);

        const result = await pool.query(
            `INSERT INTO design_approvals
                (
                    work_order_id,
                    version_no,
                    design_description,
                    color_specification,
                    material_specification,
                    modification_description,
                    design_file_url,
                    approved_total_amount, status,
                    approved_by_customer,
                    created_by
                )
             VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                        'PENDING'::approval_status,
                    false,
                    $9
                )
             RETURNING
                approval_id,
                work_order_id,
                version_no,
                design_description,
                color_specification,
                material_specification,
                modification_description,
                design_file_url,
                approved_total_amount, status,
                approved_by_customer,
                approved_at,
                rejection_reason,
                created_by,
                created_at`,
            [
                workOrderId,
                versionNo,
                design_description || null,
                color_specification || null,
                material_specification || null,
                modification_description || null,
                design_file_url || null,
                workOrder.rows[0].total_amount,
                        req.user.user_id
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Design approval created successfully',
            approval: result.rows[0]
        });

    } catch (error) {
        console.error('Create design approval error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create design approval'
        });
    }
});


router.patch('/:id/design-approvals/:approvalId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);
        const approvalId = Number(req.params.approvalId);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0 ||
            !Number.isInteger(approvalId) || approvalId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order or approval ID'
            });
        }

        const { status, rejection_reason } = req.body;

        if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid approval status'
            });
        }

        const existing = await pool.query(
            `SELECT approval_id
             FROM design_approvals
             WHERE approval_id = $1
               AND work_order_id = $2`,
            [approvalId, workOrderId]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Design approval not found'
            });
        }

        const result = await pool.query(
            `UPDATE design_approvals
             SET
                status = $1::approval_status,
                approved_by_customer = CASE
                    WHEN $1 = 'APPROVED' THEN true
                    ELSE false
                END,
                approved_at = CASE
                    WHEN $1 = 'APPROVED' THEN NOW()
                    ELSE NULL
                END,
                rejection_reason = CASE
                    WHEN $1 = 'REJECTED' THEN $2
                    ELSE NULL
                END
             WHERE approval_id = $3
               AND work_order_id = $4
             RETURNING
                approval_id,
                work_order_id,
                version_no,
                design_description,
                color_specification,
                material_specification,
                modification_description,
                design_file_url,
                status,
                approved_by_customer,
                approved_at,
                rejection_reason,
                created_by,
                created_at`,
            [
                status,
                rejection_reason || null,
                approvalId,
                workOrderId
            ]
        );

        res.json({
            success: true,
            message: 'Design approval updated successfully',
            approval: result.rows[0]
        });

    } catch (error) {
        console.error('Update design approval error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update design approval'
        });
    }
});



// ==================== QUALITY INSPECTIONS ====================

router.get('/:id/quality-inspections', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const result = await pool.query(
            `SELECT
                qi.quality_inspection_id,
                qi.work_order_id,
                qi.inspection_no,
                qi.inspector_id,
                e.full_name AS inspector_name,
                qi.inspection_round,
                qi.result,
                qi.workmanship_result,
                qi.material_result,
                qi.appearance_result,
                qi.function_result,
                qi.customer_requirements_result,
                qi.defects_found,
                qi.notes,
                qi.inspected_at
             FROM quality_inspections qi
             LEFT JOIN employees e ON e.employee_id = qi.inspector_id
             WHERE qi.work_order_id = $1
             ORDER BY qi.inspection_round DESC, qi.quality_inspection_id DESC`,
            [workOrderId]
        );

        res.json({
            success: true,
            count: result.rows.length,
            inspections: result.rows
        });

    } catch (error) {
        console.error('Get quality inspections error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get quality inspections'
        });
    }
});


router.post('/:id/quality-inspections', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order ID'
            });
        }

        const workOrder = await pool.query(
            `SELECT work_order_id
             FROM work_orders
             WHERE work_order_id = $1`,
            [workOrderId]
        );

        if (workOrder.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Work order not found'
            });
        }

        // inspector_id is optional in the current employees schema.
        // The current users table is not directly linked to employees by user_id.
        const inspectorId = null;

        const {
            result = 'PENDING',
            workmanship_result = 'PENDING',
            material_result = 'PENDING',
            appearance_result = 'PENDING',
            function_result = 'PENDING',
            customer_requirements_result = 'PENDING',
            defects_found,
            notes
        } = req.body;

        const allowedResults = ['PASSED', 'FAILED', 'PENDING'];

        const results = [
            result,
            workmanship_result,
            material_result,
            appearance_result,
            function_result,
            customer_requirements_result
        ];

        if (results.some(value => !allowedResults.includes(value))) {
            return res.status(400).json({
                success: false,
                message: 'Invalid inspection result'
            });
        }

        const latest = await pool.query(
            `SELECT COALESCE(MAX(inspection_round), 0) + 1 AS next_round
             FROM quality_inspections
             WHERE work_order_id = $1`,
            [workOrderId]
        );

        const inspectionRound = Number(latest.rows[0].next_round);

        const insertResult = await pool.query(
            `INSERT INTO quality_inspections
                (
                    work_order_id,
                    inspector_id,
                    inspection_round,
                    result,
                    workmanship_result,
                    material_result,
                    appearance_result,
                    function_result,
                    customer_requirements_result,
                    defects_found,
                    notes
                )
             VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4::inspection_result,
                    $5::inspection_result,
                    $6::inspection_result,
                    $7::inspection_result,
                    $8::inspection_result,
                    $9::inspection_result,
                    $10,
                    $11
                )
             RETURNING
                quality_inspection_id,
                work_order_id,
                inspection_no,
                inspector_id,
                inspection_round,
                result,
                workmanship_result,
                material_result,
                appearance_result,
                function_result,
                customer_requirements_result,
                defects_found,
                notes,
                inspected_at`,
            [
                workOrderId,
                inspectorId,
                inspectionRound,
                result,
                workmanship_result,
                material_result,
                appearance_result,
                function_result,
                customer_requirements_result,
                defects_found || null,
                notes || null
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Quality inspection created successfully',
            inspection: insertResult.rows[0]
        });

    } catch (error) {
        console.error('Create quality inspection error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create quality inspection'
        });
    }
});


router.patch('/:id/quality-inspections/:inspectionId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);
        const inspectionId = Number(req.params.inspectionId);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0 ||
            !Number.isInteger(inspectionId) || inspectionId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order or inspection ID'
            });
        }

        const {
            result,
            workmanship_result,
            material_result,
            appearance_result,
            function_result,
            customer_requirements_result,
            defects_found,
            notes
        } = req.body;

        const allowedResults = ['PASSED', 'FAILED', 'PENDING'];

        const values = [
            result,
            workmanship_result,
            material_result,
            appearance_result,
            function_result,
            customer_requirements_result
        ].filter(value => value !== undefined);

        if (values.some(value => !allowedResults.includes(value))) {
            return res.status(400).json({
                success: false,
                message: 'Invalid inspection result'
            });
        }

        const existing = await pool.query(
            `SELECT quality_inspection_id
             FROM quality_inspections
             WHERE quality_inspection_id = $1
               AND work_order_id = $2`,
            [inspectionId, workOrderId]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Quality inspection not found'
            });
        }

        const resultQuery = await pool.query(
            `UPDATE quality_inspections
             SET
                result = COALESCE($1::inspection_result, result),
                workmanship_result = COALESCE($2::inspection_result, workmanship_result),
                material_result = COALESCE($3::inspection_result, material_result),
                appearance_result = COALESCE($4::inspection_result, appearance_result),
                function_result = COALESCE($5::inspection_result, function_result),
                customer_requirements_result = COALESCE($6::inspection_result, customer_requirements_result),
                defects_found = COALESCE($7, defects_found),
                notes = COALESCE($8, notes)
             WHERE quality_inspection_id = $9
               AND work_order_id = $10
             RETURNING
                quality_inspection_id,
                work_order_id,
                inspection_no,
                inspector_id,
                inspection_round,
                result,
                workmanship_result,
                material_result,
                appearance_result,
                function_result,
                customer_requirements_result,
                defects_found,
                notes,
                inspected_at`,
            [
                result ?? null,
                workmanship_result ?? null,
                material_result ?? null,
                appearance_result ?? null,
                function_result ?? null,
                customer_requirements_result ?? null,
                defects_found ?? null,
                notes ?? null,
                inspectionId,
                workOrderId
            ]
        );

        res.json({
            success: true,
            message: 'Quality inspection updated successfully',
            inspection: resultQuery.rows[0]
        });

    } catch (error) {
        console.error('Update quality inspection error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update quality inspection'
        });
    }
});



// ==================== CORRECTIVE ACTIONS ====================

router.get('/:id/corrective-actions', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid work order ID' });
        }

        const result = await pool.query(
            `SELECT
                ca.corrective_action_id,
                ca.work_order_id,
                ca.quality_inspection_id,
                qi.inspection_no,
                ca.complaint_id,
                ca.nonconformity_no,
                ca.description,
                ca.root_cause,
                ca.containment_action,
                ca.corrective_action,
                ca.preventive_action,
                ca.responsible_employee_id,
                e.full_name AS responsible_employee_name,
                ca.due_date,
                ca.completed_at,
                ca.effectiveness_check,
                ca.status,
                ca.created_by,
                ca.created_at,
                ca.updated_at
             FROM corrective_actions ca
             LEFT JOIN quality_inspections qi
                ON qi.quality_inspection_id = ca.quality_inspection_id
             LEFT JOIN employees e
                ON e.employee_id = ca.responsible_employee_id
             WHERE ca.work_order_id = $1
             ORDER BY ca.corrective_action_id DESC`,
            [workOrderId]
        );

        res.json({
            success: true,
            count: result.rows.length,
            corrective_actions: result.rows
        });

    } catch (error) {
        console.error('Get corrective actions error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get corrective actions'
        });
    }
});


router.post('/:id/corrective-actions', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid work order ID' });
        }

        const workOrder = await pool.query(
            `SELECT work_order_id FROM work_orders WHERE work_order_id = $1`,
            [workOrderId]
        );

        if (workOrder.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Work order not found'
            });
        }

        const {
            quality_inspection_id,
            complaint_id,
            description,
            root_cause,
            containment_action,
            corrective_action,
            preventive_action,
            responsible_employee_id,
            due_date,
            status = 'OPEN'
        } = req.body;

        if (!description || !String(description).trim()) {
            return res.status(400).json({
                success: false,
                message: 'Description is required'
            });
        }

        const allowedStatuses = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid corrective action status'
            });
        }

        let inspectionId = null;

        if (quality_inspection_id !== undefined &&
            quality_inspection_id !== null &&
            quality_inspection_id !== '') {

            inspectionId = Number(quality_inspection_id);

            if (!Number.isInteger(inspectionId) || inspectionId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid quality inspection ID'
                });
            }

            const inspection = await pool.query(
                `SELECT quality_inspection_id
                 FROM quality_inspections
                 WHERE quality_inspection_id = $1
                   AND work_order_id = $2`,
                [inspectionId, workOrderId]
            );

            if (inspection.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Quality inspection does not belong to this work order'
                });
            }
        }

        let responsibleEmployeeId = null;

        if (responsible_employee_id !== undefined &&
            responsible_employee_id !== null &&
            responsible_employee_id !== '') {

            responsibleEmployeeId = Number(responsible_employee_id);

            if (!Number.isInteger(responsibleEmployeeId) || responsibleEmployeeId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid responsible employee ID'
                });
            }

            const employee = await pool.query(
                `SELECT employee_id
                 FROM employees
                 WHERE employee_id = $1
                   AND is_active = true`,
                [responsibleEmployeeId]
            );

            if (employee.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Responsible employee not found or inactive'
                });
            }
        }

        const insertResult = await pool.query(
            `INSERT INTO corrective_actions
                (
                    work_order_id,
                    quality_inspection_id,
                    complaint_id,
                    description,
                    root_cause,
                    containment_action,
                    corrective_action,
                    preventive_action,
                    responsible_employee_id,
                    due_date,
                    status,
                    created_by
                )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING
                corrective_action_id,
                work_order_id,
                quality_inspection_id,
                complaint_id,
                nonconformity_no,
                description,
                root_cause,
                containment_action,
                corrective_action,
                preventive_action,
                responsible_employee_id,
                due_date,
                completed_at,
                effectiveness_check,
                status,
                created_by,
                created_at,
                updated_at`,
            [
                workOrderId,
                inspectionId,
                complaint_id || null,
                String(description).trim(),
                root_cause || null,
                containment_action || null,
                corrective_action || null,
                preventive_action || null,
                responsibleEmployeeId,
                due_date || null,
                status,
                req.user.user_id
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Corrective action created successfully',
            corrective_action: insertResult.rows[0]
        });

    } catch (error) {
        console.error('Create corrective action error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create corrective action'
        });
    }
});


router.patch('/:id/corrective-actions/:actionId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    try {
        const workOrderId = Number(req.params.id);
        const actionId = Number(req.params.actionId);

        if (!Number.isInteger(workOrderId) || workOrderId <= 0 ||
            !Number.isInteger(actionId) || actionId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid work order or corrective action ID'
            });
        }

        const {
            description,
            root_cause,
            containment_action,
            corrective_action,
            preventive_action,
            responsible_employee_id,
            due_date,
            effectiveness_check,
            status
        } = req.body;

        const existing = await pool.query(
            `SELECT corrective_action_id
             FROM corrective_actions
             WHERE corrective_action_id = $1
               AND work_order_id = $2`,
            [actionId, workOrderId]
        );

        if (existing.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Corrective action not found'
            });
        }

        const allowedStatuses = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

        if (status !== undefined && !allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid corrective action status'
            });
        }

        let responsibleEmployeeId = null;

        if (responsible_employee_id !== undefined &&
            responsible_employee_id !== null &&
            responsible_employee_id !== '') {

            responsibleEmployeeId = Number(responsible_employee_id);

            if (!Number.isInteger(responsibleEmployeeId) || responsibleEmployeeId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid responsible employee ID'
                });
            }

            const employee = await pool.query(
                `SELECT employee_id
                 FROM employees
                 WHERE employee_id = $1
                   AND is_active = true`,
                [responsibleEmployeeId]
            );

            if (employee.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Responsible employee not found or inactive'
                });
            }
        }

        const updateResult = await pool.query(
            `UPDATE corrective_actions
             SET
                description = COALESCE($1, description),
                root_cause = COALESCE($2, root_cause),
                containment_action = COALESCE($3, containment_action),
                corrective_action = COALESCE($4, corrective_action),
                preventive_action = COALESCE($5, preventive_action),
                responsible_employee_id = COALESCE($6, responsible_employee_id),
                due_date = COALESCE($7, due_date),
                effectiveness_check = COALESCE($8, effectiveness_check),
                status = COALESCE($9, status),
                completed_at = CASE
                    WHEN $9 = 'COMPLETED' THEN COALESCE(completed_at, CURRENT_TIMESTAMP)
                    WHEN $9 IS NOT NULL AND $9 <> 'COMPLETED' THEN NULL
                    ELSE completed_at
                END
             WHERE corrective_action_id = $10
               AND work_order_id = $11
             RETURNING
                corrective_action_id,
                work_order_id,
                quality_inspection_id,
                complaint_id,
                nonconformity_no,
                description,
                root_cause,
                containment_action,
                corrective_action,
                preventive_action,
                responsible_employee_id,
                due_date,
                completed_at,
                effectiveness_check,
                status,
                created_by,
                created_at,
                updated_at`,
            [
                description ?? null,
                root_cause ?? null,
                containment_action ?? null,
                corrective_action ?? null,
                preventive_action ?? null,
                responsibleEmployeeId,
                due_date ?? null,
                effectiveness_check ?? null,
                status ?? null,
                actionId,
                workOrderId
            ]
        );

        res.json({
            success: true,
            message: 'Corrective action updated successfully',
            corrective_action: updateResult.rows[0]
        });

    } catch (error) {
        console.error('Update corrective action error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update corrective action'
        });
    }
});

module.exports = router;

router.get('/:id/materials', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                wom.work_order_material_id,
                wom.work_order_id,
                wom.material_id,
                m.material_code,
                m.material_name,
                m.category,
                m.unit,
                wom.quantity,
                wom.unit_cost,
                (wom.quantity * wom.unit_cost) AS line_total,
                wom.issued_by,
                u.username AS issued_by_username,
                wom.issued_at,
                wom.notes
             FROM work_order_materials wom
             JOIN materials m ON m.material_id = wom.material_id
             LEFT JOIN users u ON u.user_id = wom.issued_by
             WHERE wom.work_order_id =  $1
             ORDER BY wom.work_order_material_id`,
            [req.params.id]
        );

        res.json({
            success: true,
            count: result.rows.length,
            materials: result.rows
        });
    } catch (error) {
        console.error('Get work order materials error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get work order materials'
        });
    }
});

router.post('/:id/materials', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const workOrderId = req.params.id;
        const { material_id, quantity, unit_cost, notes } = req.body;

        if (!material_id) {
            return res.status(400).json({
                success: false,
                message: 'material_id is required'
            });
        }

        const finalQuantity = Number(quantity);

        if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
            return res.status(400).json({
                success: false,
                message: 'quantity must be greater than 0'
            });
        }

        await client.query('BEGIN');

        const workOrder = await client.query(
            `SELECT work_order_id, branch_id
             FROM work_orders
             WHERE work_order_id = $1
             FOR UPDATE`,
            [workOrderId]
        );

        if (workOrder.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Work order not found'
            });
        }

        const branchId = workOrder.rows[0].branch_id;

        const material = await client.query(
            `SELECT material_id, material_code, material_name, unit, standard_cost, is_active
             FROM materials
             WHERE material_id = $1`,
            [material_id]
        );

        if (material.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Material not found'
            });
        }

        if (!material.rows[0].is_active) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Material is inactive'
            });
        }

        const finalUnitCost =
            unit_cost !== undefined && unit_cost !== null
                ? Number(unit_cost)
                : Number(material.rows[0].standard_cost);

        if (!Number.isFinite(finalUnitCost) || finalUnitCost < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'unit_cost must be 0 or greater'
            });
        }

        const balance = await client.query(
            `SELECT inventory_balance_id, quantity_on_hand
             FROM inventory_balances
             WHERE branch_id = $1 AND material_id = $2
             FOR UPDATE`,
            [branchId, material_id]
        );

        if (balance.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'No inventory balance exists for this material in the work order branch'
            });
        }

        const currentBalance = Number(balance.rows[0].quantity_on_hand);

        if (currentBalance < finalQuantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Insufficient inventory',
                available_quantity: currentBalance,
                requested_quantity: finalQuantity
            });
        }

        const materialResult = await client.query(
            `INSERT INTO work_order_materials
                (work_order_id, material_id, quantity, unit_cost, issued_by, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING work_order_material_id, work_order_id, material_id,
                       quantity, unit_cost, issued_by, issued_at, notes`,
            [
                workOrderId,
                material_id,
                finalQuantity,
                finalUnitCost,
                req.user.user_id,
                notes || null
            ]
        );

        await client.query(
            `INSERT INTO inventory_transactions
                (branch_id, material_id, work_order_id, transaction_type,
                 quantity, unit_cost, reference_no, notes, created_by)
             VALUES ($1, $2, $3, 'ISSUE', $4, $5, $6, $7, $8)`,
            [
                branchId,
                material_id,
                workOrderId,
                finalQuantity,
                finalUnitCost,
                `WO-${workOrderId}`,
                notes || `صرف مادة لأمر العمل ${workOrderId}`,
                req.user.user_id
            ]
        );

        const newBalance = await client.query(
            `UPDATE inventory_balances
             SET quantity_on_hand = quantity_on_hand - $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE inventory_balance_id = $2
             RETURNING quantity_on_hand`,
            [finalQuantity, balance.rows[0].inventory_balance_id]
        );

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Material issued to work order and inventory updated successfully',
            work_order_material: {
                ...materialResult.rows[0],
                material_code: material.rows[0].material_code,
                material_name: material.rows[0].material_name,
                unit: material.rows[0].unit
            },
            inventory: {
                transaction_type: 'ISSUE',
                quantity_issued: finalQuantity,
                quantity_on_hand: newBalance.rows[0].quantity_on_hand
            }
        });
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Inventory rollback error:', rollbackError);
        }

        console.error('Add work order material / inventory issue error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to issue material and update inventory'
        });
    } finally {
        client.release();
    }

});

// Return material from work order to inventory
router.post('/:id/materials/return', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
    const client = await pool.connect();

    try {
        const workOrderId = req.params.id;
        const { work_order_material_id, quantity, notes } = req.body;

        if (!work_order_material_id) {
            return res.status(400).json({
                success: false,
                message: 'work_order_material_id is required'
            });
        }

        const returnQuantity = Number(quantity);

        if (!Number.isFinite(returnQuantity) || returnQuantity <= 0) {
            return res.status(400).json({
                success: false,
                message: 'quantity must be greater than 0'
            });
        }

        await client.query('BEGIN');

        const workOrder = await client.query(
            `SELECT work_order_id, branch_id
             FROM work_orders
             WHERE work_order_id = $1
             FOR UPDATE`,
            [workOrderId]
        );

        if (workOrder.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Work order not found'
            });
        }

        const branchId = workOrder.rows[0].branch_id;

        const materialResult = await client.query(
            `SELECT wom.work_order_material_id,
                    wom.work_order_id,
                    wom.material_id,
                    wom.quantity,
                    wom.unit_cost,
                    m.material_code,
                    m.material_name,
                    m.unit
             FROM work_order_materials wom
             JOIN materials m ON m.material_id = wom.material_id
             WHERE wom.work_order_material_id = $1
               AND wom.work_order_id = $2
             FOR UPDATE`,
            [work_order_material_id, workOrderId]
        );

        if (materialResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Work order material not found'
            });
        }

        const workOrderMaterial = materialResult.rows[0];
        const issuedQuantity = Number(workOrderMaterial.quantity);

        if (returnQuantity > issuedQuantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Return quantity cannot exceed issued quantity',
                issued_quantity: issuedQuantity,
                requested_return_quantity: returnQuantity
            });
        }

        const balance = await client.query(
            `SELECT inventory_balance_id, quantity_on_hand
             FROM inventory_balances
             WHERE branch_id = $1 AND material_id = $2
             FOR UPDATE`,
            [branchId, workOrderMaterial.material_id]
        );

        if (balance.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'No inventory balance exists for this material in the work order branch'
            });
        }

        await client.query(
            `INSERT INTO inventory_transactions
                (branch_id, material_id, work_order_id, transaction_type,
                 quantity, unit_cost, reference_no, notes, created_by)
             VALUES ($1, $2, $3, 'RETURN_FROM_JOB', $4, $5, $6, $7, $8)`,
            [
                branchId,
                workOrderMaterial.material_id,
                workOrderId,
                returnQuantity,
                workOrderMaterial.unit_cost,
                `WO-${workOrderId}-RETURN`,
                notes || `إرجاع مادة إلى المخزون من أمر العمل ${workOrderId}`,
                req.user.user_id
            ]
        );

        const newBalance = await client.query(
            `UPDATE inventory_balances
             SET quantity_on_hand = quantity_on_hand + $1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE inventory_balance_id = $2
             RETURNING quantity_on_hand`,
            [returnQuantity, balance.rows[0].inventory_balance_id]
        );

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Material returned to inventory successfully',
            return: {
                work_order_material_id: workOrderMaterial.work_order_material_id,
                work_order_id: workOrderId,
                material_id: workOrderMaterial.material_id,
                material_code: workOrderMaterial.material_code,
                material_name: workOrderMaterial.material_name,
                unit: workOrderMaterial.unit,
                quantity_returned: returnQuantity,
                unit_cost: workOrderMaterial.unit_cost
            },
            inventory: {
                transaction_type: 'RETURN_FROM_JOB',
                quantity_returned: returnQuantity,
                quantity_on_hand: newBalance.rows[0].quantity_on_hand
            }
        });
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Inventory return rollback error:', rollbackError);
        }

        console.error('Return work order material / inventory error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to return material and update inventory'
        });
    } finally {
        client.release();
    }
});


// ==================== DELIVERIES ====================

// GET delivery
router.get('/:id/delivery', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT
        d.delivery_id,
        d.delivery_no,
        d.work_order_id,
        d.delivered_by,
        d.received_by_customer,
        d.customer_signature_url,
        d.final_notes,
        d.delivered_at,
        u.username AS delivered_by_username
      FROM deliveries d
      LEFT JOIN users u ON u.user_id = d.delivered_by
      WHERE d.work_order_id = $1
      LIMIT 1
    `, [id]);

    res.json({
      success: true,
      delivery: result.rows[0] || null
    });
  } catch (error) {
    console.error('GET delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch delivery'
    });
  }
});


// POST delivery
router.post('/:id/delivery', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      received_by_customer,
      customer_signature_url,
      final_notes
    } = req.body;

    const workOrder = await db.query(`
      SELECT work_order_id
      FROM work_orders
      WHERE work_order_id = $1
      LIMIT 1
    `, [id]);

    if (workOrder.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Work order not found'
      });
    }

    // ==================== QMS DELIVERY GATE ====================
    // لا يسمح بتسليم السيارة إلا بعد استكمال متطلبات الجودة والاعتماد.

    const qmsCheck = await db.query(`
      SELECT
        (
          SELECT COUNT(*)
          FROM design_approvals da
          WHERE da.work_order_id = $1
            AND da.status = 'APPROVED'
            AND da.approved_by_customer = true
        ) AS approved_designs,

        (
          SELECT COUNT(*)
          FROM quality_inspections qi
          WHERE qi.work_order_id = $1
            AND qi.result = 'PASSED'
        ) AS passed_quality,

        (
          SELECT COUNT(*)
          FROM work_order_stages ws
          WHERE ws.work_order_id = $1
            AND ws.stage_name = 'التنفيذ'
            AND ws.status = 'COMPLETED'
        ) AS completed_execution,

        (
          SELECT COUNT(*)
          FROM work_order_stages ws
          WHERE ws.work_order_id = $1
            AND ws.stage_name = 'الفحص النهائي'
            AND ws.status = 'COMPLETED'
        ) AS completed_final_inspection,

        (
          SELECT COUNT(*)
          FROM work_order_stages ws
          WHERE ws.work_order_id = $1
            AND ws.stage_name = 'جاهز للتسليم'
            AND ws.status = 'COMPLETED'
        ) AS ready_for_delivery,

        (
          SELECT COUNT(*)
          FROM corrective_actions ca
          WHERE ca.work_order_id = $1
            AND ca.status <> 'COMPLETED'
        ) AS open_corrective_actions
    `, [id]);

    const qms = qmsCheck.rows[0];
    const qmsErrors = [];

    if (Number(qms.approved_designs) < 1)
      qmsErrors.push('اعتماد التصميم والخامات والسعر غير مكتمل');

    if (Number(qms.passed_quality) < 1)
      qmsErrors.push('فحص الجودة النهائي لم يجتز بنجاح');

    if (Number(qms.completed_execution) < 1)
      qmsErrors.push('مرحلة التنفيذ غير مكتملة');

    if (Number(qms.completed_final_inspection) < 1)
      qmsErrors.push('مرحلة الفحص النهائي غير مكتملة');

    if (Number(qms.open_corrective_actions) > 0)
      qmsErrors.push('يوجد إجراء تصحيحي مفتوح');

    if (Number(qms.ready_for_delivery) < 1)
      qmsErrors.push('السيارة لم تُعتمد كجاهزة للتسليم');

    if (qmsErrors.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'لا يمكن تسليم السيارة قبل استكمال متطلبات QMS',
        qms_errors: qmsErrors
      });
    }

    // ==================== END QMS DELIVERY GATE ====================

    const existing = await db.query(`
      SELECT delivery_id
      FROM deliveries
      WHERE work_order_id = $1
      LIMIT 1
    `, [id]);

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Delivery already exists for this work order'
      });
    }

    const result = await db.query(`
      INSERT INTO deliveries (
        work_order_id,
        delivered_by,
        received_by_customer,
        customer_signature_url,
        final_notes
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        delivery_id,
        delivery_no,
        work_order_id,
        delivered_by,
        received_by_customer,
        customer_signature_url,
        final_notes,
        delivered_at
    `, [
      id,
      req.user.user_id,
      received_by_customer || null,
      customer_signature_url || null,
      final_notes || null
    ]);

    await db.query(`
      UPDATE work_orders
      SET status = 'DELIVERED',
          updated_at = CURRENT_TIMESTAMP
      WHERE work_order_id = $1
    `, [id]);

    res.status(201).json({
      success: true,
      message: 'Delivery created successfully',
      delivery: result.rows[0]
    });

  } catch (error) {
    console.error('POST delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create delivery',
      error: error.message
    });
  }
});


// PATCH delivery
router.patch('/:id/delivery', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      received_by_customer,
      customer_signature_url,
      final_notes
    } = req.body;

    const result = await db.query(`
      UPDATE deliveries
      SET
        received_by_customer = COALESCE($2, received_by_customer),
        customer_signature_url = COALESCE($3, customer_signature_url),
        final_notes = COALESCE($4, final_notes)
      WHERE work_order_id = $1
      RETURNING
        delivery_id,
        delivery_no,
        work_order_id,
        delivered_by,
        received_by_customer,
        customer_signature_url,
        final_notes,
        delivered_at
    `, [
      id,
      received_by_customer,
      customer_signature_url,
      final_notes
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    res.json({
      success: true,
      message: 'Delivery updated successfully',
      delivery: result.rows[0]
    });

  } catch (error) {
    console.error('PATCH delivery error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery',
      error: error.message
    });
  }
});

// ==================== CUSTOMER FEEDBACK ====================

// GET customer feedback
router.get('/:id/feedback', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT
        f.feedback_id,
        f.work_order_id,
        f.customer_id,
        f.overall_rating,
        f.quality_rating,
        f.service_rating,
        f.delivery_rating,
        f.comment,
        f.submitted_at
      FROM customer_feedback f
      WHERE f.work_order_id = $1
      ORDER BY f.submitted_at DESC
    `, [id]);

    res.json({
      success: true,
      feedback: result.rows
    });

  } catch (error) {
    console.error('GET feedback error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customer feedback'
    });
  }
});


// POST customer feedback
router.post('/:id/feedback', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      overall_rating,
      quality_rating,
      service_rating,
      delivery_rating,
      comment
    } = req.body;

    // Check work order and customer
    const workOrder = await db.query(`
      SELECT
        work_order_id,
        customer_id
      FROM work_orders
      WHERE work_order_id = $1
      LIMIT 1
    `, [id]);

    if (workOrder.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Work order not found'
      });
    }

    const customerId = workOrder.rows[0].customer_id;

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: 'Work order has no customer'
      });
    }

    // Validate ratings
    const ratings = {
      overall_rating,
      quality_rating,
      service_rating,
      delivery_rating
    };

    for (const [field, value] of Object.entries(ratings)) {
      if (value !== undefined && value !== null) {
        const numberValue = Number(value);

        if (
          !Number.isInteger(numberValue) ||
          numberValue < 1 ||
          numberValue > 5
        ) {
          return res.status(400).json({
            success: false,
            message: `${field} must be an integer between 1 and 5`
          });
        }
      }
    }

    const result = await db.query(`
      INSERT INTO customer_feedback (
        work_order_id,
        customer_id,
        overall_rating,
        quality_rating,
        service_rating,
        delivery_rating,
        comment
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        feedback_id,
        work_order_id,
        customer_id,
        overall_rating,
        quality_rating,
        service_rating,
        delivery_rating,
        comment,
        submitted_at
    `, [
      id,
      customerId,
      overall_rating ?? null,
      quality_rating ?? null,
      service_rating ?? null,
      delivery_rating ?? null,
      comment || null
    ]);

    res.status(201).json({
      success: true,
      message: 'Customer feedback created successfully',
      feedback: result.rows[0]
    });

  } catch (error) {
    console.error('POST feedback error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create customer feedback',
      error: error.message
    });
  }
});


// PATCH customer feedback
router.patch('/:id/feedback/:feedbackId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { id, feedbackId } = req.params;

    const {
      overall_rating,
      quality_rating,
      service_rating,
      delivery_rating,
      comment
    } = req.body;

    const ratings = {
      overall_rating,
      quality_rating,
      service_rating,
      delivery_rating
    };

    for (const [field, value] of Object.entries(ratings)) {
      if (value !== undefined && value !== null) {
        const numberValue = Number(value);

        if (
          !Number.isInteger(numberValue) ||
          numberValue < 1 ||
          numberValue > 5
        ) {
          return res.status(400).json({
            success: false,
            message: `${field} must be an integer between 1 and 5`
          });
        }
      }
    }

    const result = await db.query(`
      UPDATE customer_feedback
      SET
        overall_rating = COALESCE($3, overall_rating),
        quality_rating = COALESCE($4, quality_rating),
        service_rating = COALESCE($5, service_rating),
        delivery_rating = COALESCE($6, delivery_rating),
        comment = COALESCE($7, comment)
      WHERE feedback_id = $1
        AND work_order_id = $2
      RETURNING
        feedback_id,
        work_order_id,
        customer_id,
        overall_rating,
        quality_rating,
        service_rating,
        delivery_rating,
        comment,
        submitted_at
    `, [
      feedbackId,
      id,
      overall_rating ?? null,
      quality_rating ?? null,
      service_rating ?? null,
      delivery_rating ?? null,
      comment ?? null
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer feedback not found'
      });
    }

    res.json({
      success: true,
      message: 'Customer feedback updated successfully',
      feedback: result.rows[0]
    });

  } catch (error) {
    console.error('PATCH feedback error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update customer feedback',
      error: error.message
    });
  }
});

// ==================== COMPLAINTS ====================

// GET complaints for work order
router.get('/:id/complaints', authenticateToken, authorizeWorkOrderAccess, requirePermission('WORK_ORDERS_VIEW'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT
        c.complaint_id,
        c.complaint_no,
        c.customer_id,
        c.work_order_id,
        c.severity,
        c.status,
        c.subject,
        c.description,
        c.assigned_to,
        c.resolution,
        c.resolved_at,
        c.created_by,
        c.created_at,
        c.updated_at,
        u.username AS assigned_to_username
      FROM complaints c
      LEFT JOIN users u ON u.user_id = c.assigned_to
      WHERE c.work_order_id = $1
      ORDER BY c.created_at DESC
    `, [id]);

    res.json({
      success: true,
      complaints: result.rows
    });

  } catch (error) {
    console.error('GET complaints error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch complaints'
    });
  }
});


// POST complaint
router.post('/:id/complaints', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { id } = req.params;

    const {
      severity,
      subject,
      description,
      assigned_to
    } = req.body;

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Complaint subject is required'
      });
    }

    if (!description || !String(description).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Complaint description is required'
      });
    }

    const workOrder = await db.query(`
      SELECT
        work_order_id,
        customer_id
      FROM work_orders
      WHERE work_order_id = $1
      LIMIT 1
    `, [id]);

    if (workOrder.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Work order not found'
      });
    }

    if (!workOrder.rows[0].customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Work order has no customer'
      });
    }

    let assignedTo = assigned_to ?? null;

    if (assignedTo !== null) {
      const userCheck = await db.query(`
        SELECT user_id
        FROM users
        WHERE user_id = $1
        LIMIT 1
      `, [assignedTo]);

      if (userCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Assigned user not found'
        });
      }
    }

    const allowedStatuses = [
      'OPEN',
      'UNDER_REVIEW',
      'ACTION_REQUIRED',
      'RESOLVED',
      'CLOSED',
      'REJECTED'
    ];

    const result = await db.query(`
      INSERT INTO complaints (
        customer_id,
        work_order_id,
        severity,
        status,
        subject,
        description,
        assigned_to,
        created_by
      )
      VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7)
      RETURNING
        complaint_id,
        complaint_no,
        customer_id,
        work_order_id,
        severity,
        status,
        subject,
        description,
        assigned_to,
        resolution,
        resolved_at,
        created_by,
        created_at,
        updated_at
    `, [
      workOrder.rows[0].customer_id,
      id,
      severity ?? null,
      String(subject).trim(),
      String(description).trim(),
      assignedTo,
      req.user.user_id
    ]);

    res.status(201).json({
      success: true,
      message: 'Complaint created successfully',
      complaint: result.rows[0]
    });

  } catch (error) {
    console.error('POST complaint error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create complaint',
      error: error.message
    });
  }
});


// PATCH complaint
router.patch('/:id/complaints/:complaintId', authenticateToken, requirePermission('WORK_ORDERS_MANAGE'), async (req, res) => {
  try {
    const { id, complaintId } = req.params;

    const {
      severity,
      status,
      subject,
      description,
      assigned_to,
      resolution
    } = req.body;

    const allowedStatuses = [
      'OPEN',
      'UNDER_REVIEW',
      'ACTION_REQUIRED',
      'RESOLVED',
      'CLOSED',
      'REJECTED'
    ];

    if (status !== undefined && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid complaint status. Allowed values: ${allowedStatuses.join(', ')}`
      });
    }

    if (assigned_to !== undefined && assigned_to !== null) {
      const userCheck = await db.query(`
        SELECT user_id
        FROM users
        WHERE user_id = $1
        LIMIT 1
      `, [assigned_to]);

      if (userCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Assigned user not found'
        });
      }
    }

    const resolvedAt =
      status === 'RESOLVED' || status === 'CLOSED'
        ? new Date()
        : null;

    const result = await db.query(`
      UPDATE complaints
      SET
        severity = COALESCE($3, severity),
        status = COALESCE($4, status),
        subject = COALESCE($5, subject),
        description = COALESCE($6, description),
        assigned_to = COALESCE($7, assigned_to),
        resolution = COALESCE($8, resolution),
        resolved_at = CASE
          WHEN $4 IN ('RESOLVED', 'CLOSED') THEN COALESCE(resolved_at, CURRENT_TIMESTAMP)
          WHEN $4 IS NOT NULL AND $4 NOT IN ('RESOLVED', 'CLOSED') THEN NULL
          ELSE resolved_at
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE complaint_id = $1
        AND work_order_id = $2
      RETURNING
        complaint_id,
        complaint_no,
        customer_id,
        work_order_id,
        severity,
        status,
        subject,
        description,
        assigned_to,
        resolution,
        resolved_at,
        created_by,
        created_at,
        updated_at
    `, [
      complaintId,
      id,
      severity ?? null,
      status ?? null,
      subject ?? null,
      description ?? null,
      assigned_to ?? null,
      resolution ?? null
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Complaint not found'
      });
    }

    res.json({
      success: true,
      message: 'Complaint updated successfully',
      complaint: result.rows[0]
    });

  } catch (error) {
    console.error('PATCH complaint error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update complaint',
      error: error.message
    });
  }
});



// GET /api/work-orders
router.get(
    '/',
    authenticateToken,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const isManager = (req.user.permissions || []).includes('WORK_ORDERS_MANAGE');

            if (!isManager && !req.user.employee_id) {
                return res.status(403).json({
                    success: false,
                    message: 'Employee account is not linked to an employee'
                });
            }

            let query = `
                SELECT
                    w.work_order_id,
                    w.work_order_no,
                    w.branch_id,
                    b.branch_code,
                    b.branch_name,
                    w.customer_id,
                    c.customer_no,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    c.address AS customer_address,
                    w.vehicle_id,
                    v.plate_no,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color,
                    v.mileage,
                    w.created_by,
                    u.username AS created_by_username,
                    w.assigned_to,
                    e.full_name AS assigned_to_name,
                    w.status,
                    w.priority,
                    w.received_at,
                    w.promised_at,
                    w.completed_at,
                    w.delivered_at,
                    w.customer_notes,
                    w.internal_notes,
                    w.subtotal,
                    w.discount_amount,
                    w.tax_amount,
                    w.total_amount,
                    w.deposit_amount,
                    w.balance_amount,
                    w.created_at,
                    w.updated_at
                FROM work_orders w
                JOIN branches b
                    ON b.branch_id = w.branch_id
                JOIN customers c
                    ON c.customer_id = w.customer_id
                LEFT JOIN vehicles v
                    ON v.vehicle_id = w.vehicle_id
                LEFT JOIN users u
                    ON u.user_id = w.created_by
                LEFT JOIN employees e
                    ON e.employee_id = w.assigned_to
            `;

            const params = [];

            if (!isManager) {
                params.push(req.user.employee_id);

                query += `
                    WHERE (
                        w.assigned_to = $1
                        OR EXISTS (
                            SELECT 1
                            FROM work_order_stages ws
                            WHERE ws.work_order_id = w.work_order_id
                              AND ws.assigned_to = $1
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM work_order_tasks wt
                            WHERE wt.work_order_id = w.work_order_id
                              AND wt.assigned_to = $1
                        )
                    )
                `;
            }

            query += `
                ORDER BY w.work_order_id DESC
            `;

            const result = await pool.query(query, params);

            res.json({
                success: true,
                count: result.rows.length,
                work_orders: result.rows
            });

        } catch (error) {
            console.error('Get work orders error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch work orders'
            });
        }
    }
);



// POST /api/work-orders/:id/warranty
router.post(
    '/:id/warranty',
    authenticateToken,
    requirePermission('WORK_ORDERS_MANAGE'),
    async (req, res) => {
        try {
            const workOrderId = Number(req.params.id);

            if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid work order ID'
                });
            }

            const existing = await pool.query(
                `SELECT warranty_id, warranty_no, status
                 FROM warranties
                 WHERE work_order_id = $1
                 LIMIT 1`,
                [workOrderId]
            );

            if (existing.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Warranty already exists for this work order',
                    warranty: existing.rows[0]
                });
            }

            const workOrder = await pool.query(
                `SELECT
                    w.work_order_id,
                    w.work_order_no,
                    w.customer_id,
                    w.vehicle_id,
                    w.delivered_at,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    v.plate_no,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color
                 FROM work_orders w
                 JOIN customers c ON c.customer_id = w.customer_id
                 JOIN vehicles v ON v.vehicle_id = w.vehicle_id
                 WHERE w.work_order_id = $1
                 LIMIT 1`,
                [workOrderId]
            );

            if (workOrder.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Work order not found'
                });
            }

            const order = workOrder.rows[0];

            const delivery = await pool.query(
                `SELECT delivered_at
                 FROM deliveries
                 WHERE work_order_id = $1
                 LIMIT 1`,
                [workOrderId]
            );

            if (delivery.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Vehicle must be delivered before issuing a warranty'
                });
            }

            const startDate = delivery.rows[0].delivered_at;

            const result = await pool.query(
                `INSERT INTO warranties (
                    work_order_id,
                    customer_id,
                    vehicle_id,
                    warranty_years,
                    start_date,
                    end_date,
                    status,
                    terms
                 )
                 VALUES (
                    $1,
                    $2,
                    $3,
                    5,
                    $4::date,
                    (($4::date + INTERVAL '5 years') - INTERVAL '1 day')::date,
                    'ACTIVE',
                    $5
                 )
                 RETURNING
                    warranty_id,
                    warranty_no,
                    work_order_id,
                    customer_id,
                    vehicle_id,
                    warranty_years,
                    start_date,
                    end_date,
                    status,
                    terms,
                    created_at`,
                [
                    workOrderId,
                    order.customer_id,
                    order.vehicle_id,
                    startDate,
                    'ضمان لمدة 5 سنوات على أعمال التنجيد وفق شروط الضمان المعتمدة لدى ملوك التنجيد.'
                ]
            );

            res.status(201).json({
                success: true,
                message: 'Warranty certificate created successfully',
                warranty: {
                    ...result.rows[0],
                    work_order_no: order.work_order_no,
                    customer_name: order.customer_name,
                    customer_phone: order.customer_phone,
                    plate_no: order.plate_no,
                    make: order.make,
                    model: order.model,
                    model_year: order.model_year,
                    color: order.color
                }
            });
        } catch (error) {
            console.error('POST warranty error:', error);

            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Warranty already exists for this work order'
                });
            }

            res.status(500).json({
                success: false,
                message: 'Failed to create warranty'
            });
        }
    }
);


// GET /api/work-orders/:id/warranty
router.get(
    '/:id/warranty',
    authenticateToken,
    authorizeWorkOrderAccess,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const workOrderId = Number(req.params.id);

            if (!Number.isInteger(workOrderId) || workOrderId <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid work order ID'
                });
            }

            const result = await pool.query(
                `SELECT
                    w.warranty_id,
                    w.warranty_no,
                    w.work_order_id,
                    w.customer_id,
                    w.vehicle_id,
                    w.warranty_years,
                    w.start_date,
                    w.end_date,
                    w.status,
                    w.terms,
                    w.created_at,

                    wo.work_order_no,
                    wo.branch_id,
                    b.branch_code,
                    b.branch_name,

                    c.customer_no,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    c.address AS customer_address,

                    v.plate_no,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color,
                    v.mileage

                 FROM warranties w
                 JOIN work_orders wo
                   ON wo.work_order_id = w.work_order_id
                 JOIN branches b
                   ON b.branch_id = wo.branch_id
                 JOIN customers c
                   ON c.customer_id = w.customer_id
                 LEFT JOIN vehicles v
                   ON v.vehicle_id = w.vehicle_id
                 WHERE w.work_order_id = $1
                 LIMIT 1`,
                [workOrderId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Warranty certificate not found'
                });
            }

            res.json({
                success: true,
                warranty: result.rows[0]
            });
        } catch (error) {
            console.error('GET warranty error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch warranty certificate'
            });
        }
    }
);

// GET /api/work-orders/:id
router.get(
    '/:id',
    authenticateToken,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const isManager = (req.user.permissions || []).includes('WORK_ORDERS_MANAGE');

            if (!isManager && !req.user.employee_id) {
                return res.status(403).json({
                    success: false,
                    message: 'Employee account is not linked to an employee'
                });
            }

            let query = `
                SELECT
                    w.work_order_id,
                    w.work_order_no,
                    w.branch_id,
                    b.branch_code,
                    b.branch_name,
                    w.customer_id,
                    c.customer_no,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    c.address AS customer_address,
                    w.vehicle_id,
                    v.plate_no,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color,
                    v.mileage,
                    w.created_by,
                    u.username AS created_by_username,
                    w.assigned_to,
                    e.full_name AS assigned_to_name,
                    w.status,
                    w.priority,
                    w.received_at,
                    w.promised_at,
                    w.completed_at,
                    w.delivered_at,
                    w.customer_notes,
                    w.internal_notes,
                    w.subtotal,
                    w.discount_amount,
                    w.tax_amount,
                    w.total_amount,
                    w.deposit_amount,
                    w.balance_amount,
                    w.created_at,
                    w.updated_at
                FROM work_orders w
                JOIN branches b
                    ON b.branch_id = w.branch_id
                JOIN customers c
                    ON c.customer_id = w.customer_id
                LEFT JOIN vehicles v
                    ON v.vehicle_id = w.vehicle_id
                LEFT JOIN users u
                    ON u.user_id = w.created_by
                LEFT JOIN employees e
                    ON e.employee_id = w.assigned_to
                WHERE w.work_order_id = $1
            `;

            const params = [req.params.id];

            if (!isManager) {
                params.push(req.user.employee_id);

                query += `
                    AND (
                        w.assigned_to = $2
                        OR EXISTS (
                            SELECT 1
                            FROM work_order_stages ws
                            WHERE ws.work_order_id = w.work_order_id
                              AND ws.assigned_to = $2
                        )
                        OR EXISTS (
                            SELECT 1
                            FROM work_order_tasks wt
                            WHERE wt.work_order_id = w.work_order_id
                              AND wt.assigned_to = $2
                        )
                    )
                `;
            }

            const result = await pool.query(query, params);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Work order not found'
                });
            }

            res.json({
                success: true,
                work_order: result.rows[0]
            });

        } catch (error) {
            console.error('Get work order error:', error);

            res.status(500).json({
                success: false,
                message: 'Failed to fetch work order'
            });
        }
    }
);

// GET /api/work-orders/:id/status-history
router.get(
    '/:id/status-history',
    authenticateToken,
    authorizeWorkOrderAccess,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    h.history_id,
                    h.work_order_id,
                    h.old_status,
                    h.new_status,
                    h.changed_by,
                    u.username AS changed_by_username,
                    h.changed_at
                FROM work_order_status_history h
                JOIN users u
                    ON u.user_id = h.changed_by
                WHERE h.work_order_id = $1
                ORDER BY h.history_id ASC
            `, [req.params.id]);

            res.json({
                success: true,
                work_order_id: req.params.id,
                count: result.rows.length,
                status_history: result.rows
            });

        } catch (error) {
            console.error(
                'Get work order status history error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to fetch work order status history'
            });
        }
    }
);
// GET /api/work-orders/:id/inspection
router.get(
    '/:id/inspection',
    authenticateToken,
    authorizeWorkOrderAccess,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    i.inspection_id,
                    i.work_order_id,
                    i.inspector_id,
                    e.full_name AS inspector_name,
                    i.inspection_type,
                    i.result,
                    i.mileage,
                    i.exterior_condition,
                    i.interior_condition,
                    i.existing_damage,
                    i.missing_items,
                    i.customer_requirements,
                    i.notes,
                    i.seats_condition,
                    i.dashboard_condition,
                    i.doors_condition,
                    i.roof_condition,
                    i.floor_condition,
                    i.electrical_condition,
                    i.inspector_notes,
                    i.odometer_reading,
                    i.inspected_at,
                    i.created_at,
                    i.updated_at
                FROM vehicle_inspections i
                LEFT JOIN employees e
                    ON e.employee_id = i.inspector_id
                WHERE i.work_order_id = $1
                ORDER BY i.inspection_id DESC
                `,
                [req.params.id]
            );

            res.json({
                success: true,
                work_order_id: req.params.id,
                count: result.rows.length,
                inspections: result.rows
            });

        } catch (error) {
            console.error(
                'Get vehicle inspection error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to fetch vehicle inspection'
            });
        }
    }
);

// POST /api/work-orders/:id/inspection
router.post(
    '/:id/inspection',
    authenticateToken,
    requirePermission('WORK_ORDERS_MANAGE'),
    async (req, res) => {
        const client = await pool.connect();

        try {
            const {
                vehicle_id,
                inspection_type,
                result,
                mileage,
                exterior_condition,
                interior_condition,
                existing_damage,
                missing_items,
                customer_requirements,
                notes,
                seats_condition,
                seats_notes,
                dashboard_condition,
                doors_condition,
                roof_condition,
                floor_condition,
                electrical_condition,
                inspector_notes,
                odometer_reading
            } = req.body;

            await client.query('BEGIN');

            const workOrderResult = await client.query(
                `
                SELECT
                    work_order_id,
                    vehicle_id,
                    status
                FROM work_orders
                WHERE work_order_id = $1
                FOR UPDATE
                `,
                [req.params.id]
            );

            if (workOrderResult.rows.length === 0) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    success: false,
                    message: 'Work order not found'
                });
            }

            const workOrder = workOrderResult.rows[0];

            if (
                vehicle_id &&
                String(vehicle_id) !== String(workOrder.vehicle_id)
            ) {
                await client.query('ROLLBACK');

                return res.status(400).json({
                    success: false,
                    message: 'Vehicle does not belong to this work order'
                });
            }

            const inspectorResult = await client.query(
                `
                SELECT employee_id
                FROM employees
                WHERE employee_id = $1
                `,
                [req.user.user_id]
            );

            let inspectorId = req.user.user_id;

            if (inspectorResult.rows.length === 0) {
                const employeeByUserResult = await client.query(
                    `
                    SELECT employee_id
                    FROM employees
                    WHERE user_id = $1
                    LIMIT 1
                    `,
                    [req.user.user_id]
                );

                if (employeeByUserResult.rows.length > 0) {
                    inspectorId =
                        employeeByUserResult.rows[0].employee_id;
                } else {
                    await client.query('ROLLBACK');

                    return res.status(400).json({
                        success: false,
                        message: 'Current user is not linked to an employee'
                    });
                }
            }

            const inspectionResult = await client.query(
                `
                INSERT INTO vehicle_inspections (
                    work_order_id,
                    inspector_id,
                    inspection_type,
                    result,
                    mileage,
                    exterior_condition,
                    interior_condition,
                    existing_damage,
                    missing_items,
                    customer_requirements,
                    notes,
                    inspected_at,
                    seats_condition,
                    seats_notes,
                    dashboard_condition,
                    doors_condition,
                    roof_condition,
                    floor_condition,
                    electrical_condition,
                    inspector_notes,
                    odometer_reading
                )
                VALUES (
                    $1,
                    $2,
                    COALESCE($3, 'INITIAL'),
                    COALESCE(
                        $4::inspection_result,
                        'PENDING'::inspection_result
                    ),
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    CURRENT_TIMESTAMP,
                    $12,
                    $13,
                    $14,
                    $15,
                    $16,
                    $17,
                    $18,
                    $19,
                    $20
                )
                RETURNING *
                `,
                [
                    req.params.id,
                    inspectorId,
                    inspection_type || null,
                    result || null,
                    mileage || odometer_reading || null,
                    exterior_condition || null,
                    interior_condition || null,
                    existing_damage || null,
                    missing_items || null,
                    customer_requirements || null,
                    notes || null,
                    seats_condition || null,
                    seats_notes || null,
                    dashboard_condition || null,
                    doors_condition || null,
                    roof_condition || null,
                    floor_condition || null,
                    electrical_condition || null,
                    inspector_notes || null,
                    odometer_reading || null
                ]
            );

            await client.query('COMMIT');

            res.status(201).json({
                success: true,
                message: 'Vehicle inspection created successfully',
                inspection: inspectionResult.rows[0]
            });

        } catch (error) {
            await client.query('ROLLBACK');

            console.error(
                'Create vehicle inspection error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to create vehicle inspection'
            });

        } finally {
            client.release();
        }
    }
);
// POST /api/work-orders/:id/inspection/photos
router.post(
    '/:id/inspection/photos',
    authenticateToken,
    requirePermission('WORK_ORDERS_MANAGE'),
    upload.single('photo'),
    async (req, res) => {
        const client = await pool.connect();

        try {
            const {
                inspection_id,
                photo_type,
                caption
            } = req.body;

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: 'Photo file is required'
                });
            }


            const workOrderResult = await client.query(
                `
                SELECT work_order_id
                FROM work_orders
                WHERE work_order_id = $1
                `,
                [req.params.id]
            );

            if (workOrderResult.rows.length === 0) {
                await client.query('ROLLBACK');

                fs.unlinkSync(req.file.path);

                return res.status(404).json({
                    success: false,
                    message: 'Work order not found'
                });
            }

            if (inspection_id) {
                const inspectionResult = await client.query(
                    `
                    SELECT inspection_id
                    FROM vehicle_inspections
                    WHERE inspection_id = $1
                      AND work_order_id = $2
                    `,
                    [inspection_id, req.params.id]
                );

                if (inspectionResult.rows.length === 0) {
                    await client.query('ROLLBACK');

                    fs.unlinkSync(req.file.path);

                    return res.status(400).json({
                        success: false,
                        message: 'Inspection does not belong to this work order'
                    });
                }
            }

            const fileUrl =
                `/uploads/vehicle-photos/${req.file.filename}`;

            const result = await client.query(
                `
                INSERT INTO vehicle_photos (
                    work_order_id,
                    inspection_id,
                    photo_type,
                    file_url,
                    caption,
                    uploaded_by
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
                    photo_id,
                    work_order_id,
                    inspection_id,
                    photo_type,
                    file_url,
                    caption,
                    uploaded_by,
                    created_at
                `,
                [
                    req.params.id,
                    inspection_id || null,
                    photo_type || null,
                    fileUrl,
                    caption || null,
                    req.user.user_id
                ]
            );

            await client.query('COMMIT');

            res.status(201).json({
                success: true,
                message: 'Vehicle inspection photo uploaded successfully',
                photo: result.rows[0]
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (req.file) {
                try {
                    fs.unlinkSync(req.file.path);
                } catch (fileError) {
                    console.error(
                        'Failed to remove uploaded file:',
                        fileError
                    );
                }
            }

            console.error(
                'Upload vehicle inspection photo error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to upload vehicle inspection photo'
            });

        } finally {
            client.release();
        }
    }
);
// GET /api/work-orders/:id/inspection/photos
router.get(
    '/:id/inspection/photos',
    authenticateToken,
    authorizeWorkOrderAccess,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    p.photo_id,
                    p.work_order_id,
                    p.inspection_id,
                    p.photo_type,
                    p.file_url,
                    p.caption,
                    p.uploaded_by,
                    u.username AS uploaded_by_username,
                    p.created_at
                FROM vehicle_photos p
                LEFT JOIN users u
                    ON u.user_id = p.uploaded_by
                WHERE p.work_order_id = $1
                ORDER BY p.photo_id DESC
                `,
                [req.params.id]
            );

            res.json({
                success: true,
                work_order_id: req.params.id,
                count: result.rows.length,
                photos: result.rows
            });

        } catch (error) {
            console.error(
                'Get vehicle inspection photos error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to fetch vehicle inspection photos'
            });
        }
    }
);
router.get(
    '/:id/design-approval',
    authenticateToken,
    authorizeWorkOrderAccess,
    requirePermission('WORK_ORDERS_VIEW'),
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    d.approval_id,
                    d.work_order_id,
                    d.version_no,
                    d.design_description,
                    d.color_specification,
                    d.material_specification,
                    d.modification_description,
                    d.design_file_url,
                    d.status,
                    d.approved_by_customer,
                    d.approved_at,
                    d.rejection_reason,
                    d.created_by,
                    u.username AS created_by_username,
                    d.created_at
                FROM design_approvals d
                LEFT JOIN users u
                    ON u.user_id = d.created_by
                WHERE d.work_order_id = $1
                ORDER BY d.version_no DESC
                `,
                [req.params.id]
            );

            res.json({
                success: true,
                work_order_id: req.params.id,
                count: result.rows.length,
                design_approvals: result.rows
            });

        } catch (error) {
            console.error(
                'Get design approval error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to fetch design approval'
            });
        }
    }
);
router.post(
    '/:id/design-approval',
    authenticateToken,
    requirePermission('WORK_ORDERS_MANAGE'),
    async (req, res) => {
        const client = await pool.connect();

        try {
            const {
                design_description,
                color_specification,
                material_specification,
                modification_description,
                design_file_url
            } = req.body;


            const workOrderResult = await client.query(
                `
                SELECT work_order_id, total_amount
                FROM work_orders
                WHERE work_order_id = $1
                FOR UPDATE
                `,
                [req.params.id]
            );

            if (workOrderResult.rows.length === 0) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    success: false,
                    message: 'Work order not found'
                });
            }

            const versionResult = await client.query(
                `
                SELECT COALESCE(MAX(version_no), 0) + 1 AS next_version
                FROM design_approvals
                WHERE work_order_id = $1
                `,
                [req.params.id]
            );

            const nextVersion =
                versionResult.rows[0].next_version;

            const result = await client.query(
                `
                INSERT INTO design_approvals (
                    work_order_id,
                    version_no,
                    design_description,
                    color_specification,
                    material_specification,
                    modification_description,
                    design_file_url,
                    approved_total_amount, status,
                    approved_by_customer,
                    created_by
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                                         'PENDING',
                    false,
                    $9
                )
                RETURNING *
                `,
                [
                    req.params.id,
                    nextVersion,
                    design_description || null,
                    color_specification || null,
                    material_specification || null,
                    modification_description || null,
                    design_file_url || null,
                    workOrderResult.rows[0].total_amount,
                     req.user.user_id
                ]
            );

            await client.query('COMMIT');

            res.status(201).json({
                success: true,
                message: 'Design approval created successfully',
                design_approval: result.rows[0]
            });

        } catch (error) {
            await client.query('ROLLBACK');

            console.error(
                'Create design approval error:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Failed to create design approval'
            });

        } finally {
            client.release();
        }
    }
);
// POST /api/work-orders
router.post(
    '/',
    authenticateToken,
    requirePermission('WORK_ORDERS_MANAGE'),
    async (req, res) => {
        try {
            const {
                branch_id,
                customer_id,
                vehicle_id,
                assigned_to,
                priority,
                received_at,
                promised_at,
                customer_notes,
                internal_notes,
                subtotal,
                discount_amount,
                tax_amount,
                deposit_amount
            } = req.body;

            if (!branch_id || !customer_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Branch and customer are required'
                });
            }

            const customerResult = await pool.query(
                `SELECT customer_id FROM customers WHERE customer_id = $1`,
                [customer_id]
            );

            if (customerResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer not found'
                });
            }

            if (vehicle_id) {
                const vehicleResult = await pool.query(
                    `SELECT vehicle_id, customer_id
                     FROM vehicles
                     WHERE vehicle_id = $1`,
                    [vehicle_id]
                );

                if (vehicleResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Vehicle not found'
                    });
                }

                if (
                    String(vehicleResult.rows[0].customer_id) !==
                    String(customer_id)
                ) {
                    return res.status(400).json({
                        success: false,
                        message: 'Vehicle does not belong to this customer'
                    });
                }
            }

            const branchResult = await pool.query(
                `SELECT branch_id FROM branches WHERE branch_id = $1`,
                [branch_id]
            );

            if (branchResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Branch not found'
                });
            }

            if (assigned_to) {
                const employeeResult = await pool.query(
                    `SELECT employee_id
                     FROM employees
                     WHERE employee_id = $1`,
                    [assigned_to]
                );

                if (employeeResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Assigned employee not found'
                    });
                }
            }

            const subtotalValue = Number(subtotal || 0);
            const discountValue = Number(discount_amount || 0);
            const taxValue = Number(tax_amount || 0);
            const depositValue = Number(deposit_amount || 0);

            const totalValue =
                subtotalValue - discountValue + taxValue;

            const result = await pool.query(`
                INSERT INTO work_orders (
                    work_order_no,
                    branch_id,
                    customer_id,
                    vehicle_id,
                    created_by,
                    assigned_to,
                    status,
                    priority,
                    received_at,
                    promised_at,
                    customer_notes,
                    internal_notes,
                    subtotal,
                    discount_amount,
                    tax_amount,
                    total_amount,
                    deposit_amount
                )
                VALUES (
                    generate_business_number(
                        'MK-WO-',
                        'work_order_number_seq'
                    ),
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    'NEW',
                    COALESCE(
                        $6::priority_level,
                        'NORMAL'::priority_level
                    ),
                    COALESCE(
                        $7::timestamptz,
                        CURRENT_TIMESTAMP
                    ),
                    $8,
                    $9,
                    $10,
                    $11,
                    $12,
                    $13,
                    $14,
                    $15
                )
                RETURNING
                    work_order_id,
                    work_order_no,
                    branch_id,
                    customer_id,
                    vehicle_id,
                    created_by,
                    assigned_to,
                    status,
                    priority,
                    received_at,
                    promised_at,
                    completed_at,
                    delivered_at,
                    customer_notes,
                    internal_notes,
                    subtotal,
                    discount_amount,
                    tax_amount,
                    total_amount,
                    deposit_amount,
                    balance_amount,
                    created_at,
                    updated_at
            `, [
                branch_id,
                customer_id,
                vehicle_id,
                req.user.user_id,
                assigned_to || null,
                priority || null,
                received_at || null,
                promised_at || null,
                customer_notes || null,
                internal_notes || null,
                subtotalValue,
                discountValue,
                taxValue,
                totalValue,
                depositValue
            ]);


            await createDefaultWorkOrderStages(result.rows[0].work_order_id);

        // Fetch full customer and vehicle details for PDF and WhatsApp
            const detailsResult = await pool.query(`
                SELECT
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,
                    c.address AS customer_address,
                    v.plate_no,
                    v.make,
                    v.model,
                    v.model_year,
                    v.color,
                    v.mileage
                FROM customers c
                JOIN vehicles v ON v.customer_id = c.customer_id
                WHERE c.customer_id = $1
                  AND v.vehicle_id = $2
            `, [customer_id, vehicle_id]);

            const details = detailsResult.rows[0] || {};

            const workOrderData = {
                ...result.rows[0],
                customer_name: details.customer_name,
                customer_phone: details.customer_phone,
                customer_address: details.customer_address,
                plate_no: details.plate_no,
                make: details.make,
                model: details.model,
                model_year: details.model_year,
                color: details.color,
                mileage: details.mileage
            };

            let cleanPhone = String(details.customer_phone || '').replace(/[^0-9]/g, '');

if (cleanPhone.startsWith('00')) {
    cleanPhone = cleanPhone.substring(2);
}

if (cleanPhone.startsWith('0')) {
    cleanPhone = '967' + cleanPhone.substring(1);
} else if (cleanPhone.startsWith('967')) {
    // الرقم بالفعل بصيغة دولية
} else if (cleanPhone.length == 9 && cleanPhone.startsWith('7')) {
    cleanPhone = '967' + cleanPhone;
}

console.log('WhatsApp customer phone:', details.customer_phone);
console.log('WhatsApp clean phone:', cleanPhone);

const vehicleName = [
    details.make,
    details.model,
    details.model_year
].filter(Boolean).join(' ');

const waMessage = encodeURIComponent(
`السلام عليكم ورحمة الله وبركاته

عميلنا الكريم، تم تسجيل أمر التشغيل الخاص بكم لدى ملوك التنجيد 👑

📋 رقم أمر التشغيل: ${result.rows[0].work_order_no || ''}
👤 العميل: ${details.customer_name || ''}
🚗 السيارة: ${vehicleName || 'غير محددة'}
🔢 اللوحة: ${details.plate_no || 'غير محددة'}

💰 الإجمالي: ${result.rows[0].total_amount ?? 0} ريال
💵 العربون: ${result.rows[0].deposit_amount ?? 0} ريال
📌 المتبقي: ${result.rows[0].balance_amount ?? 0} ريال

سيتم إبلاغكم عند اكتمال العمل وجاهزية السيارة للتسليم.

شكرًا لاختياركم ملوك التنجيد 👑`
);
            const whatsappUrl = cleanPhone
                ? `https://wa.me/${cleanPhone}?text=${waMessage}`
                : null;

            res.status(201).json({
                success: true,
                message: 'Work order created successfully',
                work_order: result.rows[0],
                whatsapp_url: whatsappUrl
            });
    } catch (error) {
        console.error('Get work order services error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get work order services'
        });
    }
});

// Add service to work order
